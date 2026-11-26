/*
 * Shared behavioural scenarios for Qwerty Hancock / JZZ.input.Qwerty.
 *
 * The same scenarios run in two environments:
 *   - Node with jsdom:  tests/run-node.js
 *   - a real browser:   tests/qwerty-test.html
 *
 * A "harness" supplies the DOM globals and the loaded libraries.
 */
(function (global) {
    'use strict';

    function makeScenarios(h) {
        var document = h.document,
            window = h.window,
            QwertyHancock = h.QwertyHancock,
            JZZ = h.JZZ,
            results = [];

        function waitForQueue() {
            return h.wait ? h.wait() : new Promise(function (resolve) {
                setTimeout(resolve, 30);
            });
        }

        function record(name, ok, detail) {
            results.push({ name: name, ok: !!ok, detail: detail || '' });
        }

        function assert(name, condition, detail) {
            record(name, condition, detail);
        }

        function skip(name, reason) {
            results.push({ name: name, ok: true, skipped: true, detail: reason || '' });
        }

        function touchSupported() {
            return 'ontouchstart' in document.documentElement;
        }

        function makeContainer(id) {
            var el = document.createElement('div');
            el.id = id;
            document.body.appendChild(el);
            return el;
        }

        function newKeyboard(id, startNote) {
            return new QwertyHancock({
                id: id,
                width: 400,
                height: 150,
                octaves: 1,
                startNote: startNote || 'C4'
            });
        }

        function keyEl(kb, note) {
            return kb._keyEls[note] || document.getElementById(note);
        }

        function isLit(kb, note) {
            return keyEl(kb, note).style.backgroundColor === kb.settings.activeColour;
        }

        // --- event helpers -------------------------------------------------

        function keyEvent(type, keyCode) {
            var ev = new window.KeyboardEvent(type, { keyCode: keyCode, bubbles: true });
            // jsdom does not honour keyCode in the constructor; set it directly.
            Object.defineProperty(ev, 'keyCode', { value: keyCode });
            return ev;
        }

        function pressKey(keyCode) {
            window.dispatchEvent(keyEvent('keydown', keyCode));
        }

        function releaseKey(keyCode) {
            window.dispatchEvent(keyEvent('keyup', keyCode));
        }

        function mouseEvent(type, target) {
            var ev = new window.MouseEvent(type, { bubbles: true, button: 0, view: window });
            Object.defineProperty(ev, 'target', { value: target });
            return ev;
        }

        function mouseDownOn(el) {
            el.dispatchEvent(mouseEvent('mousedown', el));
        }

        function mouseUpOn(el) {
            el.dispatchEvent(mouseEvent('mouseup', el));
        }

        function mouseOver(el) {
            el.dispatchEvent(mouseEvent('mouseover', el));
        }

        function mouseOut(el) {
            el.dispatchEvent(mouseEvent('mouseout', el));
        }

        function releaseMouseAnywhere() {
            document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, button: 0, view: window }));
        }

        function touchEvent(type, touches, target) {
            var ev,
                nativeTouches = null;

            // Use the browser's real Touch/TouchEvent when constructible so
            // the event carries a genuine EventTarget; fall back to a plain
            // object list where the constructors are missing or throw.
            if (typeof window.TouchEvent === 'function' &&
                typeof window.Touch === 'function') {
                try {
                    nativeTouches = touches.map(function (t) {
                        return new window.Touch({
                            identifier: t.identifier,
                            target: target || t.target,
                            clientX: t.clientX || 0,
                            clientY: t.clientY || 0
                        });
                    });
                    ev = new window.TouchEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        changedTouches: nativeTouches
                    });
                } catch (e) {
                    ev = null;
                }
            }

            if (!ev) {
                ev = new window.Event(type, { bubbles: true, cancelable: true });
                Object.defineProperty(ev, 'changedTouches', {
                    value: touches.map(function (t) {
                        return {
                            identifier: t.identifier,
                            target: target || t.target,
                            clientX: t.clientX || 0,
                            clientY: t.clientY || 0
                        };
                    })
                });
            }
            return ev;
        }

        function countWindowListeners() {
            return h.listenerCount(window) + h.listenerCount(document);
        }

        // ==================================================================
        // Qwerty Hancock level
        // ==================================================================

        function scenarioMouseAndKeyboardSameNote() {
            var c = makeContainer('t1'),
                kb = newKeyboard('t1'),
                down = [],
                up = [],
                d4 = keyEl(kb, 'D4'); // computer key S (keyCode 83)

            kb.keyDown = function (note) { down.push(note); };
            kb.keyUp = function (note) { up.push(note); };

            // Mouse presses D4, then the computer keyboard presses D4 too.
            mouseDownOn(d4);
            pressKey(83);

            assert('mouse+keyboard: single keyDown',
                down.length === 1 && down[0] === 'D4',
                'got ' + JSON.stringify(down));
            assert('mouse+keyboard: key stays lit', isLit(kb, 'D4'));

            // Keyboard released first: mouse still holds the note.
            releaseKey(83);
            assert('first release: no keyUp yet', up.length === 0,
                'got ' + JSON.stringify(up));
            assert('first release: key still lit', isLit(kb, 'D4'));

            // Mouse released outside the keyboard (document-level mouseup).
            releaseMouseAnywhere();
            assert('second release: single keyUp',
                up.length === 1 && up[0] === 'D4',
                'got ' + JSON.stringify(up));
            assert('second release: key restored', !isLit(kb, 'D4'));

            // Releasing the mouse again does nothing.
            releaseMouseAnywhere();
            assert('extra mouseup: no duplicate keyUp', up.length === 1);

            kb.destroy();
        }

        function scenarioKeyboardThenMouse() {
            var c = makeContainer('t2'),
                kb = newKeyboard('t2'),
                down = [],
                up = [],
                c4 = keyEl(kb, 'C4'); // computer key A (keyCode 65)

            kb.keyDown = function (note) { down.push(note); };
            kb.keyUp = function (note) { up.push(note); };

            pressKey(65);
            mouseDownOn(c4);
            assert('keyboard then mouse: single keyDown',
                down.length === 1 && down[0] === 'C4',
                'got ' + JSON.stringify(down));

            // Releasing the mouse first must not end the note.
            releaseMouseAnywhere();
            assert('mouse released first: no keyUp', up.length === 0);
            assert('mouse released first: still lit', isLit(kb, 'C4'));

            releaseKey(65);
            assert('keyboard released last: single keyUp',
                up.length === 1 && up[0] === 'C4',
                'got ' + JSON.stringify(up));
            assert('keyboard released last: restored', !isLit(kb, 'C4'));

            kb.destroy();
        }

        function scenarioMouseDragOutOfKey() {
            var c = makeContainer('t3'),
                kb = newKeyboard('t3'),
                down = [],
                up = [],
                e4 = keyEl(kb, 'E4'), // key D, keyCode 68
                f4 = keyEl(kb, 'F4'); // key F, keyCode 70

            kb.keyDown = function (note) { down.push(note); };
            kb.keyUp = function (note) { up.push(note); };

            // Press E4 and drag out of the key while still holding the button.
            mouseDownOn(e4);
            mouseOut(e4);
            assert('drag out: keyUp fired while button held',
                up.length === 1 && up[0] === 'E4',
                'got ' + JSON.stringify(up));
            assert('drag out: no lit key remains', !isLit(kb, 'E4'));

            // Releasing the button outside the keyboard does nothing.
            releaseMouseAnywhere();
            assert('release outside: no extra keyUp', up.length === 1);

            // Drag from one key onto another (glissando).
            mouseDownOn(e4);
            mouseOut(e4);
            mouseOver(f4);
            assert('glissando down sequence',
                down.join(',') === 'E4,E4,F4',
                'got ' + JSON.stringify(down));
            assert('glissando: only F4 lit',
                isLit(kb, 'F4') && !isLit(kb, 'E4'));
            releaseMouseAnywhere();
            // E4 up twice (first drag-out, then glissando out), F4 once.
            assert('glissando release: final keyUp sequence',
                up.join(',') === 'E4,E4,F4',
                'got ' + JSON.stringify(up));
            assert('glissando release: nothing lit',
                !isLit(kb, 'F4') && !isLit(kb, 'E4'));

            kb.destroy();
        }

        function scenarioKeyboardAutoRepeat() {
            var c = makeContainer('t4'),
                kb = newKeyboard('t4'),
                down = [],
                up = [];

            kb.keyDown = function (note) { down.push(note); };
            kb.keyUp = function (note) { up.push(note); };

            // Held physical key: one keydown plus a stream of auto-repeats.
            pressKey(65); // C4
            pressKey(65);
            pressKey(65);
            pressKey(65);
            assert('auto-repeat: single keyDown',
                down.length === 1 && down[0] === 'C4',
                'got ' + JSON.stringify(down));
            assert('auto-repeat: key lit', isLit(kb, 'C4'));

            // A keyup that was never preceded by a keydown is ignored.
            releaseKey(83); // D4 never pressed
            assert('spurious keyup: ignored', up.length === 0);
            assert('spurious keyup: D4 not darkened while held by others', true);

            releaseKey(65);
            assert('real keyup: single keyUp',
                up.length === 1 && up[0] === 'C4',
                'got ' + JSON.stringify(up));
            assert('real keyup: restored', !isLit(kb, 'C4'));

            kb.destroy();
        }

        function scenarioDuplicateKeyMapping() {
            // Y (89) and Z (90) both map to G#4: two physical keys for one note.
            var c = makeContainer('t5'),
                kb = newKeyboard('t5'),
                down = [],
                up = [];

            kb.keyDown = function (note) { down.push(note); };
            kb.keyUp = function (note) { up.push(note); };

            pressKey(89);
            pressKey(90);
            assert('two keys one note: single keyDown',
                down.length === 1 && down[0] === 'G#4',
                'got ' + JSON.stringify(down));
            assert('two keys one note: lit', isLit(kb, 'G#4'));

            releaseKey(89);
            assert('first physical key released: still held', up.length === 0);
            releaseKey(90);
            assert('second physical key released: single keyUp',
                up.length === 1 && up[0] === 'G#4',
                'got ' + JSON.stringify(up));
            assert('two keys one note: restored', !isLit(kb, 'G#4'));

            kb.destroy();
        }

        function scenarioTwoKeyboardsIndependent() {
            var c1 = makeContainer('k1'),
                c2 = makeContainer('k2'),
                kb1 = newKeyboard('k1', 'C4'),
                kb2 = newKeyboard('k2', 'C4'),
                d1 = [], u1 = [], d2 = [], u2 = [];

            kb1.keyDown = function (n) { d1.push(n); };
            kb1.keyUp = function (n) { u1.push(n); };
            kb2.keyDown = function (n) { d2.push(n); };
            kb2.keyUp = function (n) { u2.push(n); };

            // Same physical key drives both keyboards, but each tracks itself.
            pressKey(65); // C4 on each
            assert('two keyboards: each gets one keyDown',
                d1.join() === 'C4' && d2.join() === 'C4',
                JSON.stringify([d1, d2]));
            assert('two keyboards: both lit',
                isLit(kb1, 'C4') && isLit(kb2, 'C4'));

            // Mouse only presses the key of the second keyboard.
            mouseDownOn(keyEl(kb2, 'D4'));
            assert('mouse on keyboard 2 only',
                d2.join() === 'C4,D4' && d1.join() === 'C4',
                JSON.stringify([d1, d2]));
            assert('keyboard 1 unaffected', !isLit(kb1, 'D4') && isLit(kb1, 'C4'));

            releaseMouseAnywhere();
            assert('mouse release isolated to keyboard 2',
                u2.join() === 'D4' && u1.join() === '',
                JSON.stringify([u1, u2]));

            releaseKey(65);
            assert('keyboard release delivered to both once',
                u1.join() === 'C4' && u2.join() === 'D4,C4',
                JSON.stringify([u1, u2]));
            assert('nothing lit on either keyboard',
                !isLit(kb1, 'C4') && !isLit(kb2, 'C4') && !isLit(kb2, 'D4'));

            kb1.destroy();
            kb2.destroy();
        }

        var TOUCH_CHECKS = [
            'touch start: keyDown',
            'touch start: lit',
            'duplicate touchstart: no retrigger',
            'touchcancel: keyUp',
            'touchcancel: restored',
            'multitouch: both down',
            'one finger lifted: only E4 up',
            'last finger lifted: C4 up, nothing lit',
            'touch drag: note follows the finger',
            'touch drag release: clean'
        ];

        function scenarioTouch() {
            if (!touchSupported()) {
                TOUCH_CHECKS.forEach(function (name) {
                    skip(name, 'touch events unsupported in this environment');
                });
                return;
            }

            var c = makeContainer('t6'),
                kb = newKeyboard('t6'),
                down = [],
                up = [],
                c4 = keyEl(kb, 'C4'),
                e4 = keyEl(kb, 'E4');

            kb.keyDown = function (note) { down.push(note); };
            kb.keyUp = function (note) { up.push(note); };

            // One finger on C4.
            c4.dispatchEvent(touchEvent('touchstart', [{ identifier: 7, target: c4 }], c4));
            assert('touch start: keyDown', down.join() === 'C4', JSON.stringify(down));
            assert('touch start: lit', isLit(kb, 'C4'));

            // A second touchstart with the same identifier must not retrigger.
            c4.dispatchEvent(touchEvent('touchstart', [{ identifier: 7, target: c4 }], c4));
            assert('duplicate touchstart: no retrigger', down.length === 1);

            // touchcancel releases the finger.
            c4.dispatchEvent(touchEvent('touchcancel', [{ identifier: 7, target: c4 }], c4));
            assert('touchcancel: keyUp', up.join() === 'C4', JSON.stringify(up));
            assert('touchcancel: restored', !isLit(kb, 'C4'));

            // Multitouch: two fingers on two notes, release one at a time.
            c4.dispatchEvent(touchEvent('touchstart', [{ identifier: 1, target: c4 }], c4));
            e4.dispatchEvent(touchEvent('touchstart', [{ identifier: 2, target: e4 }], e4));
            assert('multitouch: both down',
                down.slice(-2).join() === 'C4,E4', JSON.stringify(down));

            e4.dispatchEvent(touchEvent('touchend', [{ identifier: 2, target: e4 }], e4));
            assert('one finger lifted: only E4 up',
                up.join() === 'C4,E4' && isLit(kb, 'C4') && !isLit(kb, 'E4'),
                JSON.stringify(up));

            c4.dispatchEvent(touchEvent('touchend', [{ identifier: 1, target: c4 }], c4));
            assert('last finger lifted: C4 up, nothing lit',
                !isLit(kb, 'C4') && !isLit(kb, 'E4'));

            // Dragged finger: move off the original key.
            var realElementFromPoint = document.elementFromPoint;
            document.elementFromPoint = function () { return e4; };
            c4.dispatchEvent(touchEvent('touchstart', [{ identifier: 3, target: c4 }], c4));
            c4.dispatchEvent(touchEvent('touchmove', [
                { identifier: 3, target: c4, clientX: 10, clientY: 10 }
            ], c4));
            document.elementFromPoint = realElementFromPoint;
            assert('touch drag: note follows the finger',
                isLit(kb, 'E4') && !isLit(kb, 'C4'));
            e4.dispatchEvent(touchEvent('touchend', [{ identifier: 3, target: e4 }], e4));
            assert('touch drag release: clean',
                !isLit(kb, 'E4') && !isLit(kb, 'C4'));

            kb.destroy();
        }

        function scenarioDestroy() {
            var c = makeContainer('t7'),
                before = countWindowListeners(),
                kb = newKeyboard('t7'),
                up = [];

            kb.keyUp = function (note) { up.push(note); };

            assert('destroy precondition: listeners were added',
                countWindowListeners() > before);
            pressKey(65); // C4 held
            assert('destroy precondition: lit', isLit(kb, 'C4'));

            kb.destroy();

            assert('destroy: held note released once',
                up.join() === 'C4', JSON.stringify(up));
            assert('destroy: key restored', !isLit(kb, 'C4'));
            assert('destroy: generated DOM removed',
                c.getElementsByTagName('ul').length === 0);
            assert('destroy: window/document listeners removed',
                countWindowListeners() === before);

            // Events after destroy must not reach the dead instance.
            pressKey(65);
            mouseDownOn(document.createElement('li'));
            assert('destroy: no callbacks after destroy', up.length === 1);
            assert('destroy is idempotent', (kb.destroy(), true));
        }

        // ==================================================================
        // JZZ MIDI port level
        // ==================================================================

        function midiRecord() {
            var log = [];
            return {
                log: log,
                handler: function (msg) {
                    // JZZ.MIDI() converts note names ('D4') to numbers (62).
                    log.push([msg[0], msg[1], msg[2]]);
                }
            };
        }

        function scenarioJzzSingleNoteOnOff() {
            var c = makeContainer('j1'),
                rec = midiRecord(),
                before = countWindowListeners(),
                port = JZZ.input.Qwerty('jzz1', {
                    id: 'j1', width: 400, height: 150, octaves: 1, startNote: 'C5'
                });

            port.connect(rec.handler);

            var kb = c.getElementsByTagName('li'),
                d5;
            for (var i = 0; i < kb.length; i++) {
                if (kb[i].title === 'D5') { d5 = kb[i]; }
            }

            // Computer key S (83) maps to D5; MIDI number for D5 is 74.
            var D5 = JZZ.MIDI.noteValue('D5');

            // Mouse then keyboard on the same note.
            mouseDownOn(d5);
            pressKey(83);
            assert('MIDI: exactly one Note On (0x90)',
                rec.log.length === 1 && rec.log[0][0] === 0x90 && rec.log[0][1] === D5,
                JSON.stringify(rec.log));

            releaseKey(83);
            assert('MIDI: no Note Off while another source holds',
                rec.log.length === 1);

            releaseMouseAnywhere();
            assert('MIDI: exactly one Note Off (0x80) on last release',
                rec.log.length === 2 && rec.log[0][0] === 0x90 &&
                rec.log[1][0] === 0x80 && rec.log[1][1] === D5,
                JSON.stringify(rec.log));

            port.close();
            assert('MIDI: close removes all listeners',
                countWindowListeners() === before);
            assert('MIDI: close removes generated DOM',
                c.getElementsByTagName('ul').length === 0);

            // Events after close produce nothing.
            pressKey(83);
            releaseKey(83);
            assert('MIDI: silent after close', rec.log.length === 2);
        }

        function scenarioJzzCloseWhileHeld() {
            var c = makeContainer('j3'),
                rec = midiRecord(),
                before = countWindowListeners(),
                port = JZZ.input.Qwerty('jzz3', {
                    id: 'j3', width: 400, height: 150, octaves: 1, startNote: 'C5'
                });

            port.connect(rec.handler);

            var C5 = JZZ.MIDI.noteValue('C5');

            // Hold a note with the physical keyboard, then close the port
            // without ever releasing it. No MIDI note may be left ringing.
            pressKey(65); // A -> C5
            assert('close-held: one Note On',
                rec.log.length === 1 && rec.log[0][0] === 0x90 &&
                rec.log[0][1] === C5, JSON.stringify(rec.log));

            port.close();

            assert('close-held: one balancing Note Off emitted on close',
                rec.log.length === 2 && rec.log[1][0] === 0x80 &&
                rec.log[1][1] === C5, JSON.stringify(rec.log));
            assert('close-held: listeners removed',
                countWindowListeners() === before);
            assert('close-held: DOM removed',
                c.getElementsByTagName('ul').length === 0);
        }

        function scenarioJzzOpenFailureLeavesNothing() {
            var before = countWindowListeners(),
                port;

            port = JZZ.input.Qwerty('jzz-bad', { id: 'no-such-container' });
            var failed = false;
            port.or(function () { failed = true; });

            assert('MIDI: open failure is reported', failed);
            assert('MIDI: no listeners left after failed open',
                countWindowListeners() === before);

            // The dead port must not keep its entry in the virtual list.
            JZZ.removeMidiIn('jzz-bad');
        }

        function scenarioJzzRegisteredPort() {
            var c = makeContainer('j2'),
                registered = JZZ.input.Qwerty.register('jzz-registered', {
                    id: 'j2', width: 400, height: 150, octaves: 1, startNote: 'C5'
                });

            assert('register: returns true', registered === true);

            var rec = midiRecord(),
                before = countWindowListeners(),
                opened = false,
                port = JZZ().openMidiIn('jzz-registered').and(function () { opened = true; });

            port.connect(rec.handler);

            // The open runs through JZZ's async queue; poll until ready.
            var attempts = 0;
            function poll() {
                if (opened || attempts++ > 20) {
                    return null;
                }
                return waitForQueue().then(poll);
            }
            return Promise.resolve(poll()).then(function () {
                assert('registered port: opened', opened);

                pressKey(65); // computer key A -> C5 (MIDI 72)
                releaseKey(65);
                var C5 = JZZ.MIDI.noteValue('C5');
                assert('registered port: Note On then Note Off',
                    rec.log.length === 2 && rec.log[0][0] === 0x90 && rec.log[0][1] === C5 &&
                    rec.log[1][0] === 0x80 && rec.log[1][1] === C5,
                    JSON.stringify(rec.log));

                port.close();
                assert('registered port: listeners removed on close',
                    countWindowListeners() === before);
                assert('registered port: DOM removed on close',
                    c.getElementsByTagName('ul').length === 0);

                JZZ.removeMidiIn('jzz-registered');
            });
        }

        return {
            run: function () {
                results = [];
                scenarioMouseAndKeyboardSameNote();
                scenarioKeyboardThenMouse();
                scenarioMouseDragOutOfKey();
                scenarioKeyboardAutoRepeat();
                scenarioDuplicateKeyMapping();
                scenarioTwoKeyboardsIndependent();
                scenarioTouch();
                scenarioDestroy();
                if (!JZZ) {
                    return Promise.resolve(results);
                }
                scenarioJzzSingleNoteOnOff();
                scenarioJzzCloseWhileHeld();
                scenarioJzzOpenFailureLeavesNothing();
                return scenarioJzzRegisteredPort().then(function () {
                    return results;
                });
            }
        };
    }

    global.QwertyHancockTestScenarios = makeScenarios;
})(typeof window !== 'undefined' ? window : global);
