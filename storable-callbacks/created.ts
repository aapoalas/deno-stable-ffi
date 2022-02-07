const lib = Deno.dlopen("lib.so", {
  /**
   * Register a callback that will be called for each queue item when `drain_queue` is called.
   * Mark the function parameter with `persist` to describe to Deno that this callback should be
   * retained on call.
   */
  register_queue_callback: {
    parameters: [
      {
        function: {
          parameters: ["pointer"],
          result: "u8",
        },
      },
    ],
    result: "u8",
  },
  /**
   * Clears the registered queue callback.
   */
  clear_queue_callback: {
    parameters: [],
    result: "u8",
  },
  /**
   * Drain current queue by calling the callback from `register_queue_callback` for each item in queue.
   */
  drain_queue: {
    parameters: [],
    result: "void",
  },
});

class StoredCallback {
  #rid: any;
  #description: Deno.ForeignFunction;
  #callback: Function;

  constructor(description: Deno.ForeignFunction, callback: Function) {
    this.#rid = 0; // Get rid from Deno call.
    this.#description = description;
    this.#callback = callback;
  }

  deregister() {
    // Removes Rust-side data
  }

  // Note: No `call()` method. This is intentional to avoid weird cases where a callback is occasionally
  // called from FFI and occasionally from JS. Keep it simple.
}

function noAccidentalUseAfterFree() {
  // Now creation of the stored callback is explicit.
  // It is much harder to accidentally leak memory.
  const callback = new StoredCallback(
    {
      parameters: ["pointer"],
      result: "u8",
    },
    (pointer: Deno.UnsafePointer) => {
      console.log("Got pointer", pointer.value);
    }
  );
  const result = (
    lib.symbols.register_queue_callback as unknown as (
      callback: StoredCallback
    ) => number
  )(callback);
  return result === 0;
  // Now, even though `callback` goes out of scope the actual callback Resource is held by Deno. (Presuming that the `callback` function can be kept alive by Deno Rust side.)
  // We're of course leaking the resource here but at least it is very clear that something is leaking.
}

function easyDeregister() {
  // Create a callback.
  const callback = new StoredCallback(
    {
      parameters: ["pointer"],
      result: "u8",
    },
    (pointer: Deno.UnsafePointer) => {
      console.log("Got pointer", pointer.value);
    }
  );
  // Register the callback.
  (
    lib.symbols.register_queue_callback as unknown as (
      callback: StoredCallback
    ) => number
  )(callback);
  // Later, clear the queue callback and remove the callback resource.
  lib.symbols.clear_queue_callback();
  callback.deregister();
  // That was easy! Deno does not need to assign callbacks into the `lib` object,
  // does not need to keep track of stored callbacks used in different FFI calls, etc.
}
