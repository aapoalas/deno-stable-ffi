/**
 * Now Deno does not accept plain TypedArray values as arguments in
 * nonblocking FFI calls. Deno will call `v8_ArrayBuffer_Detach` on
 * the internal buffer of `OwnedPointer`. When the call returns it will
 * replace the internal buffer with a new `ArrayBuffer` object with
 * the same backing store (meaning no copying occurs).
 */

class OwnedPointer {
  #buffer: ArrayBuffer;

  constructor(length: number) {
    this.#buffer = new ArrayBuffer(length);
  }

  /**
   * Returns the internal ArrayBuffer instance.
   *
   * SAFETY: If the OwnedPointer is passed into an unblocking FFI call, the buffer will be detached and becomes 0-length.
   * After detaching the buffer cannot be read from or written into.
   */
  getBuffer() {
    return this.#buffer;
  }
}

const lib = Deno.dlopen("lib.so", {
  nonblocking_ffi_call: {
    parameters: ["pointer"],
    result: "u8",
    nonblocking: true,
  },
});

const nonblockingCall = lib.symbols.nonblocking_ffi_call as unknown as (
  pointer: OwnedPointer
) => Promise<number>;

function noUserAfterFree() {
  // Create a new pointer with some data.
  const pointer = new OwnedPointer(8);
  // Note the explicitness in accessing the buffer. This is intentional to keep
  // direct buffer manipulation an "expensive" operation.
  const buffer = pointer.getBuffer();
  new BigUint64Array(buffer)[0] = 35n;
  // Call the library using the pointer and return the result.
  return nonblockingCall(pointer);
  // The internal ArrayBuffer becomes detached, while the pointer object itself goes
  // out of scope. Deno needs to handle the pointer object having been garbage collected
  // by clearing out the internal buffer when the nonblocking call returns.
}

function noConcurrentAccess(): Promise<number> {
  // Create a new pointer with some data.
  const pointer = new OwnedPointer(8);
  const buffer = pointer.getBuffer();
  const bigUint64Array = new BigUint64Array(buffer);
  bigUint64Array[0] = 3n;
  // Call the library using the pointer and save the promise.
  const promise = nonblockingCall(pointer);
  // The internal buffer has now become empty
  if (buffer.byteLength !== 0 || bigUint64Array.length !== 0) {
    throw new Error("Unreachable");
  }
  // Trying to assign into it just assigns into the object, it does not actually write into the buffer.
  bigUint64Array[0] = 6n;
  return promise;
  // We've safely gotten the result without causing concurrent access problems. But what if we wanted to read some result from the buffer?
}

async function easyReadAfterCall(): Promise<BigInt> {
  // Create a new pointer with some data.
  const pointer = new OwnedPointer(8);
  const buffer = pointer.getBuffer();
  const bigUint64Array = new BigUint64Array(buffer);
  bigUint64Array[0] = 3n;
  // Call the library and get the result
  const result = await nonblockingCall(pointer);
  if (result === 0) {
      // Call succeeded, retrieve data
      return new BigUint64Array(pointer.getBuffer())[0];
  } else {
      throw new Error("Copy failed");
  }
}

noUserAfterFree();
noConcurrentAccess();
easyReadAfterCall();