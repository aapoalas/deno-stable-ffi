# Proposal(s) for a stable API for Deno FFI

In this repository I propose a possible stable APIs for Deno FFI. The proposals are split into folders by topic, and each folder contains multiple options on what I consider possible APIs for the topic. Some of those possible APIs can be pretty explicit strawman arguments to illustrate issues in alternative APIs, thus guiding to the actual proposal or proposals.

The proposals will have a walkthrough below, with each step guiding the reader through my reasons for proposing said APIs.

## Nonblocking FFI calls

Deno currently has nonblocking FFI calls, usable by setting the `nonblocking` flag in the FFI call definition as `true`. These calls spawn a separate Tokio blocking thread which will perform the actual library call and when the call is over will pass the return value back to the main thread using message passing. The FFI symbol in JS returns a Promise which resolves once the spawned thread returns. There are two large issues with the current API:

1. Determining the thread-safety of the library call. This is something that the FFI user should be cognizant about and is not something that Deno can do anything about.
2. Usage of JS ArrayBuffers in nonblocking FFI calls is at best dangerous and can lead to anything from undefined behaviour and data races to crashes. [[1]](https://github.com/denoland/deno/issues/12341) [[2]](https://github.com/denoland/deno/issues/12653)

A few simplified examples of current issues can be viewed [here](nonblocking/current.ts). As mentioned in [1] it is clear that the current state is unsound and needs improvement. The lack of sharing across threads is mentioned as the issue and while this is true, using a `SharedArrayBuffer` properly would require that the receiving library also uses atomics which Deno cannot guarantee. [citation needed, the author does not understand the internals of `SharedArrayBuffer` / futexes, and the implications of those in FFI]

Luckily, there is no need to use `SharedArrayBuffer` if we detach the `ArrayBuffer` when it gets passed into a (nonblocking) FFI call. V8 offers a [Detach API](https://v8docs.nodesource.com/node-16.13/d5/d6e/classv8_1_1_array_buffer.html#abb7a2b60240651d16e17d02eb6f636cf) to facilitate safely passing a buffer from one thread to another. For nonblocking FFI calls this is relevant in that it allows for a buffer to be created and potentially manipulated inside JavaScript, then passed into an FFI call with all the existing JS references becoming invalid to access and safe to garbage collect without destroying the backing store, ie. the actual memory.

### Using plain buffers with Detach

The immediate choice is to keep using plain `ArrayBuffer` objects (or typed arrays, more specifically). This is simple, retains existing unstable FFI API logic and introduces no additional constructs into FFI usage. It also does not work. The basic issues are outlined [here](nonblocking/plain_buffers.ts).