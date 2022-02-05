const lib = Deno.dlopen("lib.so", {
    nonblocking_ffi_call: {
        parameters: [
            "pointer"
        ],
        result: "u8",
        nonblocking: true,
    },
});

const nonblockingCall: (buffer: Deno.TypedArray) => Promise<number> = lib.symbols.nonblocking_ffi_call;

function useAfterFree(): Promise<number> {
    // Create a new buffer with some data.
    const buffer = new BigUint64Array(1);
    // Call the library using the buffer and return the result.
    return nonblockingCall(buffer);
    // Buffer may get garbage collected before library can use it, causing Use-After-Free.
    // In Rust terms, the compiler would complain that the lifetime of the reference to buffer outlives the lifetime of the buffer.
}

async function concurrentAccess() {
    // Create a new buffer with some data.
    const buffer = new BigUint64Array(1);
    // Call the library using the buffer and save the promise.
    const promise = nonblockingCall(buffer);
    // Reading or writing into the buffer is undefined behaviour until the promise resolves.
    // We can still write into it, changing the memory that the library is accessing while the call is ongoing.
    // In Rust terms, the compiler would complain that there are two `&mut` references to the buffer.
    buffer[0] = 3n;
    // The library might change the memory from underneath us as well.
    if (buffer[0] !== 3n) {
        // We might well end up here.
        throw new Error("Memory changed!");
    }
    await promise;
    // Now accessing and writing into the memory is safe again.
    if (buffer[0] !== 3n) {
        buffer[0] = 3n;
    }
    if (buffer[0] !== 3n) {
        // We cannot end up here now. (Except if the library does unspeakable things, like saved a raw pointer
        // pointing at our memory and keeps touching it even after the call has finished.)
        throw new Error("Memory still changed!");
    }
    return promise;
}

useAfterFree();
concurrentAccess();