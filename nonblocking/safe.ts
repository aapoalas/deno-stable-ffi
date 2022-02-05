/**
 * Again, Deno does not accept plain TypedArray values as arguments in
 * nonblocking FFI calls. Deno will call `v8_ArrayBuffer_Detach` on
 * the internal buffer of `OwnedPointer`. When the call returns it will
 * replace the internal buffer with a new `ArrayBuffer` object with
 * the same backing store (meaning no copying occurs).
 *
 * Additionally, `Deno.UnsafePointer.of()` static method is removed to
 * ensure that JS code cannot contain a pointer to `OwnedPointer` data.
 * With this, we can completely seal off any chance that JS could keep
 * a reference to an `OwnedPointer`'s internal buffer.
 *
 * To do this we need to use the `structuredClone` API. A better alternative
 * will be the `ArrayBuffer.prototype.transfer` method if/when it lands.
 * See: https://tc39.es/proposal-resizablearraybuffer/#sec-arraybuffer.prototype.transfer
 */

class OwnedPointer {
  #buffer: ArrayBuffer;

  /**
   * Constructs a new OwnedPointer. If passed an ArrayBuffer or
   * TypedArray, the OwnedPointer will take ownership of the buffer
   * and the passed-in buffer object will become detached, zero-size
   * and no longer pointing to any data.
   *
   * This transfer of ownership is a zero-copy operation.
   */
  constructor(arg: number | ArrayBuffer | Deno.TypedArray) {
    if (typeof arg === "number") {
      this.#buffer = new ArrayBuffer(arg);
    } else if (arg instanceof ArrayBuffer) {
      this.#buffer = structuredClone(arg, { transfer: [arg] });
      // this.#buffer = arg.transfer();
    } else if (
      typeof arg === "object" &&
      arg &&
      arg.buffer instanceof ArrayBuffer
    ) {
      this.#buffer = structuredClone(arg.buffer, { transfer: [arg.buffer] });
    } else {
      throw new TypeError("Invalid invocation");
    }
  }

  /**
   * Transfers the ownership of the data from the OwnedPointer
   * to the caller by returning an ArrayBuffer.
   *
   * Implementation note: This could also optionally return the internal
   * buffer as-is and assign `null` or `new ArrayBuffer(0)` to the internal
   * buffer slot. Whatever is preferred, but it needs to be consistent with
   * how nonblocking FFI calls work.
   */
  transfer(): ArrayBuffer {
    if (this.#buffer.byteLength === 0) {
      throw new Error("Cannot transfer ownership from detached buffer");
    }
    return structuredClone(this.#buffer, { transfer: [this.#buffer] });
  }

  /**
   * Consider implementing a method to get a DataView to the buffer.
   * 
   * Any read and write operations on the DataView will throw an explicit
   * error if the buffer has been detached.
   */
  getDataView(): DataView {
      return new DataView(this.#buffer);
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
  // Create a new pointer from some data.
  const data = new BigUint64Array(1);
  data[0] = 3n;
  const pointer = new OwnedPointer(data);
  if (data.length !== 0) {
    // The view has become empty since ownership was transferred to `OwnedPointer`.
    throw new Error("Unreachable");
  }
  // Note that we now cannot take back ownership of the buffer and then use the
  // pointer object. Doing so will throw an immediate error from Deno's internal checks.

  // Call the library using the pointer and return the result.
  return nonblockingCall(pointer);
  // The internal ArrayBuffer becomes detached, while the pointer object itself goes
  // out of scope. Deno needs to handle the pointer object having been garbage collected
  // by clearing out the internal buffer when the nonblocking call returns.
}

function noConcurrentAccess(): Promise<number> {
  // Create a new pointer from some data.
  const data = new BigUint64Array(1);
  data[0] = 3n;
  const pointer = new OwnedPointer(data);
  // Call the library using the pointer and save the promise.
  const promise = nonblockingCall(pointer);
  // Attempting to take back ownership of the pointer's data will now immediately throw an error.
  try {
    const buffer = pointer.transfer();
    // We'll never get here. The assignment cannot occur.
    const bigUint64Array = new BigUint64Array(buffer);
    bigUint64Array[0] = 6n;
  } catch (err) {
    console.log(err.message);
  }
  return promise;
  // We've safely gotten the result without causing concurrent access problems. What about reading data from the pointer?
}

async function easyReadAfterCall(): Promise<BigInt> {
  // Create a new pointer from some data.
  const data = new BigUint64Array(1);
  data[0] = 3n;
  const pointer = new OwnedPointer(data);
  // Call the library and get the result
  const result = await nonblockingCall(pointer);
  if (result === 0) {
    // Call succeeded, retrieve data
    return new BigUint64Array(pointer.transfer())[0];
  } else {
    throw new Error("Copy failed");
  }
}

noUserAfterFree();
noConcurrentAccess();
easyReadAfterCall();

async function appendix() {
    // Why remove `Deno.UnsafePointer.of`?

    // 1. It is unnecessary.
    const data = new Uint8Array(8);
    const pointer = Deno.UnsafePointer.of(data);
    // OwnedPointer just provides stronger guarantees of safety as we've seen.
    const equivalentPointer = new OwnedPointer(data);

    // 2. It re-creates the concurrent read bug that `OwnedPointer` is solving, though writes are forbidden.
    const promise = nonblockingCall(equivalentPointer);
    // `equivalentPointer` is now detached and we cannot access its data. The same applies to `data` since
    // `new OwnedPointer(data)` detached it earlier.
    // However, we can get read access using the `UnsafePointerView` class.
    const pointerView = new Deno.UnsafePointerView(pointer);
    console.log("First byte is:", pointerView.getUint8());
    await promise;

    // 3. I feel it makes sense to keep "foreign data" and "own data" strictly separate.
    // `UnsafePointer` should always point to some foreign data that is explicitly allocated and given or borrowed to us.
    // Additionally, I think that allowing `UnsafePointer` construction manually is probably crazy.
    const randomBigInt = BigInt(Math.round(Math.random() * 1000000));
    const randomPointer = new Deno.UnsafePointer(randomBigInt);
    const randomPointerView = new Deno.UnsafePointerView(randomPointer);
    randomPointerView.getArrayBuffer(1024); // This will likely segfault. 
    // If it does not, that's perhaps even worse. What did we just read?
    // The only reason I can imagine to keep the constructor is to allow "following pointers" from inside an `UnsafePointerView`.
    const innerPointerAddress = randomPointerView.getBigUint64(24); // Presume we know that there is a pointer at this offset.
    const innerPointer = new Deno.UnsafePointer(innerPointerAddress);
    // However, the same could be implemented on `UnsafePointerView` if it is wanted:
    const sameInnerPointer = randomPointerView.getUnsafePointer(24); // Same as `getBigUint64` but returns as `UnsafePointer`.
    console.log(innerPointer, sameInnerPointer);
}

appendix();