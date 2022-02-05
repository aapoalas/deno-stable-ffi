/**
 * Now Deno calls `v8_ArrayBuffer_Detach` on all buffers passed into
 * FFI calls.
 */

const lib = Deno.dlopen("lib.so", {
  nonblocking_ffi_call: {
    parameters: ["pointer"],
    result: "u8",
    nonblocking: true,
  },
});

const nonblockingCall: (buffer: Deno.TypedArray) => Promise<number> =
  lib.symbols.nonblocking_ffi_call;

function noUseAfterFree(): Promise<number> {
  // Create a new buffer with some data.
  const buffer = new BigUint64Array(1);
  // Call the library using the buffer and return the result.
  return nonblockingCall(buffer);
  // The buffer is now detached and thus the BigUint64Array object can be safely garbage collected.
  // It will not remove the backing store, which is what the library is actually accessing.
  // Deno needs to take care of letting V8 know when the buffer is actually to be removed by destructuring
  // the `std::shared_ptr<BackingStore>`.
}

function noConcurrentAccess(): Promise<number> {
  // Create a new buffer with some data.
  const buffer = new BigUint64Array(1);
  // Call the library using the buffer and save the promise.
  const promise = nonblockingCall(buffer);
  // The buffer is now empty
  if (buffer.byteLength !== 0) {
    throw new Error("Unreachable");
  }
  // Trying to assign into it just assigns into the object, it does not actually write into the buffer.
  buffer[0] = 3n; // The buffer object now has a property "0". We could do the same with "foo" and the result would be equivalent.
  return promise;
  // We've safely gotten the result without causing concurrent access problems. But what if we wanted to read some result from the buffer?
}

async function noReadingAfterCall(): Promise<BigInt> {
  // Create a new buffer with some data.
  const buffer = new BigUint64Array(1);
  // Call the library using the buffer and await the result
  const result = await nonblockingCall(buffer);
  if (result === 0) {
    // OK signal, some value was copied into our buffer
    // ... But how do we now read the buffer data?
    // This does not actually work. The result will be `undefined` since
    // the buffer's byteLength is now 0, there is no 0th element anymore.
    const bufferValue = buffer[0];
    if (typeof bufferValue === "bigint") {
      // We'll never get here. There is no way to access the detached buffer's data anymore.
      return bufferValue;
    }
    // Deno could possibly add an API to fetch a new buffer pointing to the same backing store, eg.
    const returnBuffer = Deno.reattachBuffer(buffer);
    // but that may be problematic with eg. buffer lifetime to backing store mapping binding.
    // Also, this API lacks elegance.
    if (returnBuffer instanceof ArrayBuffer) {
        return new BigUint64Array(returnBuffer, 0, 1)[0];
    }
    throw new Error("Could not get result");
  } else {
    throw new Error("Copy failed");
  }
}

async function uglyReturnValue(): Promise<BigInt> {
  // We can of course change the FFI call API to return new buffers alongside the result.
  const uglyNonblockingCall = nonblockingCall as unknown as (
    buffer: Deno.TypedArray
  ) => Promise<{ result: number; buffers: ArrayBuffer[] }>;

  // Create a new buffer with some data.
  const buffer = new BigUint64Array(1);
  // Call the library using the buffer and await the result
  const {
      result,
      buffers
  } = await uglyNonblockingCall(buffer);

  // The original buffer is still detached and becomes unavailable, but now we can get
  // the value from the returned buffers array.
  if (result === 0) {
      // Now either the nonblocking FFI call API differs in its return value from the 
      // blocking API, or the blocking API will also return an object with result and buffers.
      // Either this means that the blocking API will also detach all buffers (which is
      // unnecessary for the blocking API case) and those need to be reclaimed from the return
      // value, or alternatively for the blocking case the buffers will always be an empty array.
    const returnBuffer = buffers[0];
    return new BigUint64Array(returnBuffer, 0, 1)[0];
  } else {
      throw new Error("Copy failed");
  }
}

noConcurrentAccess();
noReadingAfterCall();
uglyReturnValue();