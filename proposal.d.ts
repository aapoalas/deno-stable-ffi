/**
 * Replaces current `UnsafePointer`. Rust wise this is `&T`.
 */
export class ForeignPointer {
  /**
   * Throws, manual construction not allowed
   */
  constructor();
  // No prototype or static methods available.
}

/**
 * Replaces current `UnsafeFnPointer`. This is no longer created from
 * `ForeignPointer` but is instead automatically returned based on FFI
 * symbol declaration. A symbol with return value of `{ function: { parameters, result } }`
 * will return either `null` or `ForeignFunction`.
 */
export class ForeignFunction<Fn extends Deno.ForeignFunction> {
  /**
   * Throws, manual construction not allowed
   */
  constructor();

  /**
   * Call method just as presently.
   */
  call(
    ...args: Deno.StaticForeignFunctionParameters<Fn["parameters"]>
  ): Deno.ConditionalAsync<
    Fn["nonblocking"],
    Deno.StaticForeignFunctionResult<Fn["result"]>
  >;
}

/**
 * Equivalent to current `UnsafePointerView` with one (optional) addition.
 *
 * Consider naming `ForeignDataView`?
 */
export class ForeignPointerView {
  constructor(pointer: ForeignPointer);

  /**
   * Optional added method, data-access wise equivalent to `getBigUint64`
   */
  getForeignPointer?(offset?: number): ForeignPointer;

  /**
   * Optional added method to allow foreign functions to be extracted from structs.
   */
  getForeignFunction?<T extends Deno.ForeignFunction>(
    offset?: number
  ): ForeignFunction<T>;
}

/**
 * Strictly safe wrapper around JS-owned data
 */
export class OwnedPointer {
  /**
   * Takes ownership of passed-in buffer, detaching it.
   */
  constructor(arg: number | ArrayBuffer | Deno.TypedArray);

  /**
   * Returns ownership of the buffer, detaching it from the OwnerPointer.
   * The OwnedPointer becomes unusable after this. Throws if called twice.
   */
  transfer(): ArrayBuffer;

  /**
   * Optionally, implement a helper method to get a DataView into the buffer
   * while still keeping ownership of the buffer in `OwnedPointer`. This
   * Sort of goes against the safety guarantees, but `DataView` will throw
   * on reads and writes if the buffer becomes detached.
   */
  getDataView?(): DataView;

  /**
   * Optionally, add a method to allow for foreign functions pointers assigned
   * into owned pointers to be extracted for use.
   *
   * This really only makes sense for `BigUint64Array(1)` buffers.
   */
  getForeignFunction?<T extends Deno.ForeignFunction>(): ForeignFunction<T>;
}

/**
 * Describes a stored function
 */
interface StoredFunctionDescription {
  parameters: Deno.ForeignFunction["parameters"];
  result: Deno.ForeignFunction["result"];
  /**
   * Controls whether this callback should be callable from other threads. Defaults to false.
   *
   * If set, the callback calling and return value handling will be passed through an mspc channel.
   * For this boolean to be deadlock free, Deno must internally be able to tell the event loop thread
   * apart.
   */
  threadSafe?: boolean;
  /**
   * Controls whether an `async` callback is allowed. Callback will be awaited before returning.
   * Only allowed if `threadSafe` is set true.
   *
   * This is a relatively dangerous control to put in with little upside. Consider this optional
   * or discouraged part of the proposal.
   */
  nonblocking?: boolean;
}

/**
 * Wrapper class for stored callbacks. A stored callback can passed to a native library with
 * the library keeping a reference to the C callback it receives. The reference will be valid
 * until `delete()` is called.
 *
 * The callback an be either synchronous (called only on the event loop thread) or thread-safe
 * (can be called on any thread).
 */
export class StoredCallback<Fn extends StoredFunctionDescription> {
  readonly threadSafe: boolean;

  constructor(description: Fn, callback: Deno.StaticForeignFunction<Fn>);

  /**
   * Delete the stored callback and all its data.
   *
   * Using a deleted `StoredCallback` in FFI functions will throw an error.
   */
  delete(): void;
}
