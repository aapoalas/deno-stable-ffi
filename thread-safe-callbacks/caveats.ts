/**
 * This file mixes and matches JS code and "Rust" / C / native library code or Deno FFI calls to native code.
 * Anything written with underscores (eg. `stored_callback`) is native side.
 * Anything written in camelCase is JS side.
 */

/**
 * Some native library internal slot to keep a callback
 */
let stored_callback: (buffer: Uint8Array) => boolean;

/**
 * Some FFI API. Since this is external code, there is no `async` there,
 * at least not the same `async` as JavaScript uses. The same applies to the
 * `cb` parameter. It must be a C function pointer, those are not async.
 */
function ffi_store_callback(cb: (buffer: Uint8Array) => boolean) {
  stored_callback = cb;
}

/**
 * FFI API that calls the stored callback with some calculated data.
 * The callback should return 0/1 as boolean to signal of possible errors.
 * Here an error is considered fatal.
 */
function ffi_call_callbacks() {
  // Calculate some data.
  const data = new Uint8Array(1);
  data[0] = 13;
  // Call the callback
  const result = stored_callback(data);
  // Call is done, assert result and return
  if (result !== true) {
    throw new Error("FATAL ERROR");
  }
}

/**
 * JS side callback.
 */
async function shouldBeSyncCallback(buffer: Uint8Array) {
  // Callback received, lets fetch some data that will help us calculate a proper result.
  const helpData = await new Promise((res) => setTimeout(() => res(13), 1000));
  // Time to return
  return helpData == buffer[0];
}

function syncCallbackCannotBeAsync() {
  // Store the callback. Note that we must lie here to even get the types to match. This is not a good sign.
  ffi_store_callback(
    shouldBeSyncCallback as unknown as (buffer: Uint8Array) => boolean
  );
  // Now we call the callback synchronously through this FFI call. What will happen is that the FFI call creates
  // data and calls the C function pointer with the data, so far so good. The C function will then call our "sync"
  // JS callback.
  ffi_call_callbacks();
  // The callback returns a Promise, and Deno's Rust side cannot magically handle a Promise on the main
  // thread in such a way that the Promise would resolve into a valid number to return to the C function.
  // (Or if there is a way, then it's something like looping on the Deno side of the FFI callback, calling into
  // tokio to spin the event loop, until the Promise gets resolved. Sounds like a bad API.)
  // As such, this is a case of an invalid function return value and will error. Additionally, since the JS
  // callback first did async work and only then read data through the pointer (buffer) it received, the data will be
  // gone by the time it gets around to reading it.
}

let stored_thread_safe_callback: (
  buffer: Uint8Array
) => boolean | Promise<boolean>;

/**
 * FFI API to save a thread safe callback. Now we'll accept a Promise-valued return as well.
 */
function ffi_store_thread_safe_callback(
  cb: (buffer: Uint8Array) => boolean | Promise<boolean>
) {
  stored_thread_safe_callback = cb;
}

/**
 * Multiple producer, single consumer message channel. Used 1-to-1 here.
 * In honesty this would be two mspc's but lets not think about that now.
 * This has been passed to send and receive trampolines beforehand.
 */
const mspc_channel = new Int32Array(new SharedArrayBuffer(4));

/**
 * Deno's internal code to synchronize an external thread's call to a thread-safe
 * callback onto the event loop thread.
 */
async function ffi_call_consumer() {
  // Wait for a message on the channel. We should not block here though, as that would block the event loop.
  const { value: promise } = Atomics.waitAsync(mspc_channel, 0, 0);
  await promise;
  // Message received, extract data from index 1
  const value = Atomics.load(mspc_channel, 1);
  // Now we're on the main thread and the caller (producer) thread is locked waiting for a message to come on the
  // mspc_channel. We can thus feel free to do async work before we send our return value as a message on the channel.
  const data = new Uint8Array(1);
  data[0] = value;
  const result = await stored_thread_safe_callback(data);
  // We got our result, now lets transfer it back to the caller.
  Atomics.store(mspc_channel, 0, 0);
  Atomics.store(mspc_channel, 1, result ? 1 : 0);
  Atomics.notify(mspc_channel, 0);
}

let ffi_call_producer = function ffi_call_producer(data: Uint8Array): boolean {
  // Send value a to receive
  Atomics.store(mspc_channel, 0, 1);
  Atomics.store(mspc_channel, 1, data[0]);
  Atomics.notify(mspc_channel, 0);
  // Now wait for a reply on the channel, blocking the thread so that we can return `boolean` synchronously.
  Atomics.wait(mspc_channel, 0, 1);
  // Once 0th value changes back to 0, we have return value available in index 1
  const value = Atomics.load(mspc_channel, 1);
  return value === 1;
};

/**
 * Calls stored thread safe callback. Should be called from threads other than event loop thread.
 */
function ffi_call_async_callback() {
  // Calculate some data.
  const data = new Uint8Array(1);
  data[0] = 13;
  // Call the callback but since we're prepared to be called from another thread, we need to synchronize.
  // To do that, we must use indirection. This indirection is not really in the native library but
  // inside Deno's ext/ffi. This call here is actually the true C callback that the native library receives.
  // Thus, it is by necessity a synchronous call.
  const result = ffi_call_producer(data);
  if (result !== true) {
    throw new Error("FATAL ERROR");
  }
}

/**
 * Lets reuse the previous callback.
 */
const asyncCallback = shouldBeSyncCallback;

function threadSafeCallbackInEventLoop() {
  // This time we store a callback with the native library that is meant to be called from other threads.
  // To show in JS terms the issues with this, I will use `Atomics` though this is not necessary or wanted in actual
  // thread-safe callback usage.
  // First lets store the callback.
  ffi_store_thread_safe_callback(asyncCallback);
  // We'll also setup the `ffi_call_consumer` (though this wouldn't actually done like this in Deno).
  ffi_call_consumer();
  // Now lets say that the callback gets called from the event loop thread for some reason. (Essentially: As a synchronous reply to some other FFI API call.)
  ffi_call_async_callback();
  // The `ffi_call_producer` will send a message on the channel for `ffi_call_consumer()` and then will also lock the calling thread
  // to wait for a reply.
  // But, since the `ffi_call_producer` is being called from the event loop thread this means that the event loop thread locks up and
  // the consumer can never answer the message that would allow the producer to return. This is a deadlock.
}

threadSafeCallbackInEventLoop();

/**
 * Deno internal API that returns true when the call is done on the event loop,
 * otherwise returns false.
 */
function is_event_loop_thread() {
  return true; // Technically true for JS code. Real implementation would differ slightly.
}

/**
 * Lets avoid the deadlock using the `is_event_loop_thread()` API.
 */
ffi_call_producer = function thread_aware_ffi_call_producer(data: Uint8Array) {
  // Send value a to receive
  Atomics.store(mspc_channel, 0, 1);
  Atomics.store(mspc_channel, 1, data[0]);
  Atomics.notify(mspc_channel, 0);
  // Now, if we're on the event loop we must not block the thread!
  if (is_event_loop_thread()) {
    // But what do we do now? We're back to the issue with `syncCallbackCannotBeAsync`.
    // The only reasonable choice is to panic.
    throw new Error("FATAL ERROR");
  } else {
    // On other threads we can block safely
    Atomics.wait(mspc_channel, 0, 1);
  }
  // Once 0th value changes back to 0, we have return value available in index 1
  const value = Atomics.load(mspc_channel, 1);
  return value === 1;
};

function threadSafeCallbackInAnyLoop() {
    // Again, store the callback
    ffi_store_thread_safe_callback(asyncCallback);
    // Setup the consumer
    ffi_call_consumer();
    // Call the callback from the event loop thread. This will throw.
    ffi_call_async_callback();
    setTimeout(() => {
        // Call the callback from "another" thread. (Pretend this is another thread.)
        // Now the call will succeed (if you squint).
        ffi_call_async_callback();
    }, Math.round(Math.random() * 1000));
}