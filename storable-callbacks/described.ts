const lib = Deno.dlopen("lib.so", {
    /**
     * Register a callback that will be called for each queue item when `drain_queue` is called.
     * Mark the function parameter with `persist` to describe to Deno that this callback should be
     * retained on call.
     */
  register_queue_callback: {
    parameters: [{
        function: {
            parameters: ["pointer"],
            result: "u8",
        },
        persist: true,
    }],
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

function useAfterFree() {
    // If Deno's Rust side cannot keep the callback alive, then this function
    // will lead to use-after-free segfaults when the C callback attempts to
    // call the JS callback, which has already gone out of scope and been garbage collected.
    const result = lib.symbols.register_queue_callback((pointer: Deno.UnsafePointer) => {
        console.log(pointer.value);
    }) as number;
    return result === 0; // OK
}

let registeredCallback: Function | undefined;

function howToDeregister() {
    // Create a callback and keep a reference to it.
    const callback = () => { console.log("Callback") };
    // Register the callback.
    lib.symbols.register_queue_callback(callback);
    // Later, clear the queue callback as we no longer care about the queue.
    lib.symbols.clear_queue_callback();
    // Now, how do we tell Deno that the callback can be freed?
    registeredCallback = callback;
    optionA();
    optionB();
}

function optionA() {
    // Add an API to the FFI lib resource to deregister callbacks.
    // Perhaps place the API in an object that contains values for FFI APIs that
    // can have persisted callbacks in the first place.
    libs.callbacks.register_queue_callback.deregister(
      registeredCallback
    );
    // There are some complexities here, though:
    // 1. Same callback can be used to call the same API multiple times. Deno FFI needs to cache by callback function object to avoid issues.
    // 2. Same API can be called multiple times with different callbacks. Deno FFI needs internal handling to map one-API-to-many-callbacks.
    // 3. Same callback can be used to call multiple different APIs. User needs to remember where callback has been used.
    // 4. Again, even if Deno's Rust side can keep the callback alive even if `callback` itself goes out of scope and is garbage collected,
    //    that would cause memory to leak. This may be intentional, though.
}

function optionB() {
    // Add an API to access persisted callbacks. Again, perhaps have the API be FFI API targeted:
    libs.callbacks.register_queue_callback.forEach(cbHandle => cbHandle.deregister());
    // This could be done in addition to optionA, fixing the potential memory leak from A#4 by allowing the callbacks to be deregistered
    // explicitly through this API even if the callback object itself is no longer known. However, this API cannot really tell one
    // callback from another and might proc use-after-free errors when a still-used handle is deregistered along with the rest.
}

function accidentalMisuse() {
    // It is quite likely that a Deno "*-sys library" to use the Rust term will
    // hide the details of the FFI API behind a more palatable API. Perhaps something like this:
    /**
     * Handles queue draining. Queue is drained every 1000 milliseconds automatically.
     * 
     * Only call this API once with the desired callback.
     */
    const niceApi = (callback: Function) => {
      lib.symbols.register_queue_callback(callback);
    };
    // Now, of course the user should only call the API once but what if they misunderstand and think
    // they can call the API once for each callback they want to receive?
    niceApi((data: boolean) => {
        if (data) {
            console.log("Got proper data");
        }
    });
    niceApi((data: boolean) => {
        if (!data)  {
            console.log("Got invalid data");
        }
    });
    // The Deno library should of course handle this but it's clear that it's relatively easy to accidentally leak memory with this.
    // A casual user of the direct FFI API won't even have any idea if their callback will be persisted or not:
    lib.symbols.register_queue_callback((err: number, result: number) => {
        console.log("I thought this is a callback that returns error or result!", err, result);
    });

    // Of course, these memory leaks are fixable using the `optionA()` and `optionB()` calls. The API itself and especially the
    // deregistering are, however, very inelegant.
}