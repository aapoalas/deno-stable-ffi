# Proposal(s) for a stable API for Deno FFI

In this repository I propose a possible stable APIs for Deno FFI. The proposals are split into folders by topic, and each folder contains multiple options on what I consider possible APIs for the topic. Some of those possible APIs can be pretty explicit strawman arguments to illustrate issues in alternative APIs, thus guiding to the actual proposal or proposals.

The proposals will have a walkthrough below, with each step guiding the reader through my reasons for proposing said APIs.

### TL;DR?

```ts
/**
 * Replaces current `UnsafePointer`. Rust wise this is `&T`.
 */
class ForeignPointer {
    /**
     * Throws, manual construction not allowed
     */
    constructor(): never;
    // No prototype or static methods available.
}

/**
 * Equivalent to current `UnsafePointerView` with one (optional) addition.
 * 
 * Consider naming `ForeignDataView`?
 */
class ForeignPointerView {
    constructor(pointer: ForeignPointer);

    /**
     * Optional added method, data-access wise equivalent to `getBigUint64`
     */
    getForeignPointer?(offset?: number): ForeignPointer;
}

/**
 * Strictly safe wrapper around JS-owned data
 */
class OwnedPointer {
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
}
```

## Nonblocking FFI calls

Deno currently has nonblocking FFI calls, usable by setting the `nonblocking` flag in the FFI call definition as `true`. These calls spawn a separate Tokio blocking thread which will perform the actual library call and when the call is over will pass the return value back to the main thread using message passing. The FFI symbol in JS returns a Promise which resolves once the spawned thread returns. There are two large issues with the current API:

1. Determining the thread-safety of the library call. This is something that the FFI user should be cognizant about and is not something that Deno can do anything about.
2. Usage of JS ArrayBuffers in nonblocking FFI calls is at best dangerous and can lead to anything from undefined behaviour and data races to crashes. [[1]](https://github.com/denoland/deno/issues/12341) [[2]](https://github.com/denoland/deno/issues/12653)

A few simplified examples of current issues can be viewed [here](nonblocking/current.ts). As mentioned in [1] it is clear that the current state is unsound and needs improvement. The lack of sharing across threads is mentioned as the issue and while this is true, using a `SharedArrayBuffer` properly would require that the receiving library also uses atomics which Deno cannot guarantee. [citation needed, the author does not understand the internals of `SharedArrayBuffer` / futexes, and the implications of those in FFI]

Luckily, there is no need to use `SharedArrayBuffer` if we detach the `ArrayBuffer` when it gets passed into a (nonblocking) FFI call. V8 offers a [Detach API](https://v8docs.nodesource.com/node-16.13/d5/d6e/classv8_1_1_array_buffer.html#abb7a2b60240651d16e17d02eb6f636cf) to facilitate safely passing a buffer from one thread to another. For nonblocking FFI calls this is relevant in that it allows for a buffer to be created and potentially manipulated inside JavaScript, then passed into an FFI call with all the existing JS references becoming invalid to access and safe to garbage collect without destroying the backing store, ie. the actual memory.

### Using plain buffers with Detach

The immediate choice is to keep using plain `ArrayBuffer` objects (or typed arrays, more specifically). This is simple, retains existing unstable FFI API logic and introduces no additional constructs into FFI usage. It also does not work. The basic issues are outlined [here](nonblocking/plain_buffers.ts).

In short: Reclaiming the `ArrayBuffer` after it has been detached is difficult.

### Wrapping buffers

Reclaiming the `ArrayBuffer` directly is difficult but if it is passed inside an object, then assigning a new `ArrayBuffer` into the object in place of the original is simple. A naive implementation of this would be like this:

```ts
class WrappedBuffer {
    buffer: ArrayBuffer;
}
```

However, we can do better. We can either be [guarded](nonblocking/guarded.ts) with the buffer and try document and show with the API to the user that they cannot trust the buffer in all cases, or we can [explicitly block all direct access](nonblocking/safe.ts) to the buffer.

Explicitly blocking all direct access would make Deno FFI's internal invariant guarantees rigorous and impossible to break. The required changes to the current FFI API to do this are discussed in the appendix in [safe.ts](nonblocking/safe.ts). That discussion acts as a good leadup to the foreign pointers part of this proposal.

## Foreign data handling

The current state of foreign pointers in Deno FFI is in my opinion on good, solid ground. There are only two truly soft spots:

1. Creating pointers to JavaScript's own buffers. This gives JS a backdoor to read ArrayBuffer data sent to other threads for nonblocking operations concurrently.
2. Creating pointers by bigint. The only reasonable use-case I can think of is to "read behind" a pointer contained within some pointer gotten through FFI. This would be better served by a method on the DataView class equivalent.

With these two removals (and corresponding additions), I would be ready to rename `UnsafePointer` to `ForeignPointer` or perhaps `FfiPointer` and bring it to stable.

## Synchronized, storable callbacks

TBD. Basic use case is to provide an FFI library with a callback that can be called one or many times from the event loop thread. These callbacks can but are not necessarily called synchronously when they're originally "registered" to the FFI library. The callback will be called synchronously in response to some FFI call from the event loop. Since these can only be called in response to an FFI call from the event loop, these should not keep Deno from exiting.

Questions:
1. From Deno's point of view, ddoes the registering need to be done on the event loop thread, or can that be done using a non-blocking call if so wanted?
2. Do these need to be separate from thread-safe callbacks? What are the costs and benefits for implementing these separately?

I expect these to need an explicit constructable class.

## Thread-safe callbacks

TBD. Basic use case is to provide an FFI library with a callback that can be called one or many times from one or more threads other than the event loop thread. These callbacks probably should not be called synchronously when they're originally "registered" to the FFI library. The JS callback will be called on the event loop after some message passing magic orchestrated by Deno.

Excellent proof of concept by @DjDeveloperr is available [here](https://github.com/DjDeveloperr/deno_threadsafe_callback_poc).

It is a bit unclear if this should just be the same thing as storable callbacks. One issue with the proof of concept is that a deadlock occurs if a thread-safe callback expecting a return value is called from the event loop thread. This might be avoidable using a thread-local flag on the event loop thread.

Questions:
1. If the JavaScript side callback is `async`, should the thread-safe callback thread block until the JS promise resolves? What happens if the promise rejects?

# Acknowledgements

This proposal is not mine to claim credit for, not fully at the very least. The following persons were of immense help:
* @DjDeveloperr
* @divy
* @Andreu Botella
* @evan
* @bartlomieju
* @crowlKats