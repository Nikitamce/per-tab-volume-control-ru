/**
 * MAIN-world play() hook.
 *
 * Runs in the page's own JavaScript world (manifest `"world": "MAIN"`, document_start, all frames).
 * It wraps HTMLMediaElement.prototype.play so the isolated media detector can find media that is
 * never attached to the DOM (for example `new Audio().play()`), then announces each playing
 * element with a CustomEvent on `document`.
 *
 * The wrapper is a page-owned function on purpose. A function exported from the isolated
 * content-script compartment dies with the extension (update, disable, reload with the tab open)
 * and every later play() on that page then throws "can't access dead object". Page-owned code
 * keeps working with or without the extension.
 *
 * Rules this file must keep:
 * - Call the original with the real `this` and no arguments (play() takes none).
 * - Return the original result untouched; never wait for, or depend on, any listener.
 * - Never throw into the page: a failed dispatch is swallowed, a failing play() propagates as is.
 * - Add no globals and no shared state with the isolated scripts. The event name must equal
 *   window.VolumeControl.PLAY_HOOK_EVENT (content_scripts/utils/constants.js); this world cannot
 *   load that file, so tests/main-world-play-hook.test.js keeps the two literals equal.
 */
(function () {
    'use strict';

    const PLAY_HOOK_EVENT = '__vc_play';
    const HOOK_MARK = Symbol.for('perTabVolumeControl.playHook');

    const proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
    if (!proto || typeof proto.play !== 'function' || proto.play[HOOK_MARK] === true) {
        return;
    }

    // Capture everything the wrapper needs now, so later page changes to these globals cannot
    // break it (and so a page cannot redirect the dispatch).
    const originalPlay = proto.play;
    const apply = Reflect.apply;
    const EventCtor = window.CustomEvent;
    const dispatchEvent = document.dispatchEvent;

    const hook = {
        play() {
            const result = apply(originalPlay, this, []);
            try {
                // Ignore off-DOM <audio> elements (e.g. Web Audio / translation scripts like VOT).
                if (this instanceof window.HTMLAudioElement && !this.isConnected) {
                    return result;
                }
                apply(dispatchEvent, document, [new EventCtor(PLAY_HOOK_EVENT, { detail: this })]);
            } catch (err) {
                // Discovery is best effort; it must never affect the page's own play() call.
            }
            return result;
        }
    }.play;

    Object.defineProperty(hook, HOOK_MARK, { value: true });

    try {
        proto.play = hook;
    } catch (err) {
        // A frozen prototype cannot be hooked; the isolated detector still has its other paths.
    }
})();
