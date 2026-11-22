/**
 * MAIN-world element.volume setter hook.
 *
 * Runs in the page's own JavaScript world (manifest `"world": "MAIN"`, document_start, all frames),
 * next to play_hook_main.js. It wraps the HTMLMediaElement `volume` setter and, after the page's
 * write has landed and really changed the value, announces the element with a CustomEvent on
 * `document`.
 *
 * Why it exists: Firefox applies element.volume to the output within the next audio block, but the
 * `volumechange` event is an asynchronous main-thread task. Any delay before it runs (page jank, a
 * busy event loop) is audible as a burst of the page's own level. This event is dispatched
 * synchronously inside the page's write, so the isolated content script can hold the level in the
 * same task, before the next audio block, and let its normal decision logic settle it afterwards.
 *
 * The hook only notifies. It never changes, vetoes or delays the write, and it never reads back
 * anything the page could not read itself.
 *
 * The wrapper is a page-owned function on purpose (see play_hook_main.js): a function exported from
 * the isolated compartment dies with the extension, and every later `video.volume = x` would then
 * throw "can't access dead object".
 *
 * Rules this file must keep:
 * - Run the original setter first, with the real `this` and the page's value, and let its errors
 *   (for example an out-of-range RangeError) propagate unchanged.
 * - Leave the native getter untouched.
 * - Never throw into the page: failed reads and failed dispatches are swallowed.
 * - Announce only when the value changed (an unchanged write fires no `volumechange`).
 * - Add no globals and no shared state with the isolated scripts. The event name must equal
 *   window.VolumeControl.VOLUME_HOOK_EVENT (content_scripts/utils/constants.js); this world cannot
 *   load that file, so tests/main-world-play-hook.test.js keeps the two literals equal.
 */
(function () {
    'use strict';

    const VOLUME_HOOK_EVENT = '__vc_volume';
    const HOOK_MARK = Symbol.for('perTabVolumeControl.volumeHook');

    const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'volume');
    if (
        !descriptor ||
        descriptor.configurable !== true ||
        typeof descriptor.get !== 'function' ||
        typeof descriptor.set !== 'function' ||
        descriptor.set[HOOK_MARK] === true
    ) {
        return;
    }

    // Capture everything the wrapper needs now, so later page changes to these globals cannot
    // break it (and so a page cannot redirect the dispatch).
    const originalGet = descriptor.get;
    const originalSet = descriptor.set;
    const apply = Reflect.apply;
    const EventCtor = window.CustomEvent;
    const dispatchEvent = document.dispatchEvent;

    const hook = {
        set volume(value) {
            let before;
            try {
                before = apply(originalGet, this, []);
            } catch (err) {
                // The original setter below raises whatever the page should see.
            }

            apply(originalSet, this, [value]);

            try {
                if (apply(originalGet, this, []) !== before) {
                    apply(dispatchEvent, document, [new EventCtor(VOLUME_HOOK_EVENT, { detail: this })]);
                }
            } catch (err) {
                // The announcement is best effort; it must never affect the page's own write.
            }
        }
    };
    const hookSetter = Object.getOwnPropertyDescriptor(hook, 'volume').set;

    Object.defineProperty(hookSetter, HOOK_MARK, { value: true });

    try {
        Object.defineProperty(proto, 'volume', {
            configurable: true,
            enumerable: descriptor.enumerable,
            get: originalGet,
            set: hookSetter
        });
    } catch (err) {
        // A locked prototype cannot be hooked; the asynchronous volumechange path still works.
    }
})();
