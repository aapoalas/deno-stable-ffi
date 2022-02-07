/**
 * Welcome to the bonus section. V8's Locker API offers a way for V8 to be
 * multithreaded, at least somehow. I am unclear on what sort of magics this allows,
 * but lets presume that this can magically be made to work.
 * 
 * In this case, Atomics become actually relevant. A pseudo-example is below.
 */

function register_parallel_callback(cb: Function) {
    // TBD
}

function spawn() {
    // TBD
}

function parallelJavaScript() {
    const sab = new SharedArrayBuffer(1024);
    const notifyPoint = new Int32Array(sab, 0, 1);
    const array = new Uint8Array(sab);

    // This callback will truly be run in differen threads than the rest of the code.
    // When the callback is initialized, Deno will use `v8::Locer` to lock the isolate
    // (possibly create a new one if needed) and call the callback there. I'm magically
    // presuming that the `sab` is visible there. I'm probably wrong.
    // This callback should in reality of course be a StoredCallback.
    const parallelCallback = (index: number, data: number) => {
        Atomics.store(array, index, data);
        Atomics.store(notifyPoint, 0, index);
        Atomics.notify(notifyPoint, 0);
    };

    register_parallel_callback(parallelCallback);

    // Lots of parallel threads!
    for (let i = 0; i < 32; i++) {
        spawn();
    }

    // Now we wait for the results to come streaming in!
    let counter = 0;
    let prev = 0;
    while (true) {
        // This probably wouldn't actually work in the proper order. Lets not care about that now.
        const result = Atomics.wait(notifyPoint, 0, prev, 10000);
        if (result === "ok") {
            const index = Atomics.load(array, 0);
            prev = index;
            counter += Atomics.load(array, index);
        } else {
            break;
        }
    }
    console.log("Result:", counter);
    // Now if that wasn't interesting, then I don't know what is! Deno probably does not want to
    // open this can of (user) worms, not at the moment at least. Something to think about in the future?
}