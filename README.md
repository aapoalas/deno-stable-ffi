# Proposal(s) for a stable API for Deno FFI

In this repository I propose a possible stable APIs for Deno FFI. The proposals are split into folders by topic, and each folder contains multiple options on what I consider possible APIs for the topic. Some of those possible APIs can be pretty explicit strawman arguments to illustrate issues in alternative APIs, thus guiding to the actual proposal or proposals.

The proposals will have a walkthrough below, with each step guiding the reader through my reasons for proposing said APIs.

### [TL;DR](proposal.d.ts)

I propose a pretty much maximally restricted API, aligned with Rust's borrow semantics as much as possible. Pointer can only be received through FFI and not constructed, their actual bigint pointer value cannot be directly observed. Passing a buffer into a synchronous FFI call is allowed but nonblocking FFI calls only take in special `OwnedPointer` objects that hold the buffer internally and can only transfer ownership out, never give a reference.
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

## Synchronous, storable callbacks

Imagine a native library with an API consisting of two calls: `registerQueueCallback` and `drainQueue`. The first API is used to store a synchronous callback. The second synchronously causes the stored callback to be called 0..n times, once for each item in some internal queue of pending items.

In this case, the Deno FFI call would of course need to take some sort of callback function as a parameter and internally store it for an undetermined lifetime. Since the callback is always called from the event loop thread there is no concurrency issues to be considered. Likewise, we do not need to consider the possibility that the callback would need to wake up the event loop as the event loop is already awake when the callback happens. The only true question is: How to determine the lifetime of the callback function? Specifically, how long should the JavaScript callback function live, and how tie that lifetime together with the lifetime of the Rust side callback info and the actual C callback?

Lets explore the possible API choices to try and find an answer to the questions.

### Using plain functions

Again, the immediate choice is to use plain functions in the FFI calls and store the `Local<Function>` objects on Rust side to keep the callback alive. Deno would need to be told if the callback should be stored or not through the FFI call's API description.

However, we run to a similar issue as with [using plain buffers](#Using-plain-buffers-with-Detach) in nonblocking calls: The callback might be "lost" inside the call if the JS side does not keep a reference to it. Deno's Rust side can (I think) still keep the V8 function alive but now there is no way to tell Deno that the callback is no longer needed.
[Lets take a look at the issues.](storable-callbacks/described.ts).

In short: Removing stored callbacks becomes difficult and inelegant. At the FFI call level, telling apart a synchronous callback and a persisted callback becomes impossible.

### Wrapping functions

We once again return to the option of wrapping our parameter in an object. This time our reason for doing so is not about data reclamation but explicitness of creation, parameter type, and deregisteration. [Lets take a look at how this could work.](storable-callbacks/created.ts)

That seems like a pretty clear-cut result. However, before we make any rash decisions lets take a look at thread-safe callbacks as well.

## Thread-safe callbacks

What if the native library wants to call back to Deno from some other thread? Or at worst, what if it wants to call back from both the event loop thread _and_ other threads? For this we need thread-safe callbacks. Since these callbacks will be called not in synchronous response to an FFI call but at an indeterminate later time, these callbacks need to always be stored. As such, we can directly skip over the `Using plain functions` part since the same issues are present here as above.

The real question here comes from the difference with synchronous storable callbacks. First is the question: Does there need to be a difference? I think the answer is "no, with caveats." These caveats are:

1. Asynchronicity of the actual JS callback function. Synchronous callbacks cannot be `async`. ie. The FFI callback `fn() -> u8` cannot be answered by a JS callback `() => Promise<number>` run on the same thread. This is not the case for thread-safe callbacks when they're called from other threads.
2. If thread-safe callbacks are to be callable from the main thread as well, then there needs to be a way to determine if the call is happening on the main thread.

Lets explore these caveats with some [pseudo-code](thread-safe-callbacks/caveats.ts).

As we see, `async` callbacks can be used when the callback comes from a separate thread but on the main thread they force us to panic out of the call. As such, while enabling usage of `async` functions as callbacks for thread-safe callbacks would be very cool, it is quite likely to result in a lot of tears and gnashing of teeth. It is best that callbacks are kept synchronous, if for no other reason than to make sure that the calling thread is blocked for as little time as possible. It will likely be a good idea to warn users of even using callbacks with long chains of calculations, leading to other FFI calls etc. It is best if the callback coming from another thread is hurriedly extracted of necessary data and any subsequent calculations then delayed via eg. `setTimeout` to allow for the callback to return immediately.

An excellent proof of concept for thread-safe callbacks by @DjDeveloperr is available [here](https://github.com/DjDeveloperr/deno_threadsafe_callback_poc). The POC however allows for asynchronous callback functions and is implemented in such a way that a "return" can be triggered multiple times. Thus, the API offered in the POC is not suitable as is.

I propose a variation of DJ's version with synchronous, storable callbacks rolled into the same API.

# Acknowledgements

This proposal is not mine to claim credit for, not fully at the very least. The following persons (in no particular order) were of immense help:
* @DjDeveloperr
* @divy
* @Andreu Botella
* @evan
* @bartlomieju
* @crowlKats