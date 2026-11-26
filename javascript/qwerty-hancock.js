/*
 * Qwerty Hancock keyboard library v0.5.2
 * The web keyboard for now people.
 * Copyright 2012-15, Stuart Memo
 *
 * Licensed under the MIT License
 * http://opensource.org/licenses/mit-license.php
 *
 * http://stuartmemo.com/qwerty-hancock
 */

(function () {
    var root = this;
    /* In <script> context, `this` is the window.
     * In node context (browserify), `this` is the node global.
     */
    var globalWindow = typeof global === 'undefined' ? root : root.window,
        version = '0.5.2',
        key_map = {
            65: 'Cl',
            87: 'C#l',
            83: 'Dl',
            69: 'D#l',
            68: 'El',
            70: 'Fl',
            84: 'F#l',
            71: 'Gl',
            89: 'G#l',
            90: 'G#l',
            72: 'Al',
            85: 'A#l',
            74: 'Bl',
            75: 'Cu',
            79: 'C#u',
            76: 'Du',
            80: 'D#u',
            59: 'Eu',
            186: 'Eu',
            222: 'Fu',
            221: 'F#u',
            220: 'Gu'
        };

    /**
     * Calculate width of white key.
     * @return {number} Width of a single white key in pixels.
     */
    var getWhiteKeyWidth = function (settings, number_of_white_keys) {
        return Math.floor((settings.width - number_of_white_keys) / number_of_white_keys);
    };

    /**
     * Get frequency of a given note.
     * @param  {string} note Musical note to convert into hertz.
     * @return {number} Frequency of note in hertz.
     */
    var getFrequencyOfNote = function (note) {
        var notes = ['A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#'],
            key_number,
            octave;

        if (note.length === 3) {
            octave = note.charAt(2);
        } else {
            octave = note.charAt(1);
        }

        key_number = notes.indexOf(note.slice(0, -1));

        if (key_number < 3) {
            key_number = key_number + 12 + ((octave - 1) * 12) + 1;
        } else {
            key_number = key_number + ((octave - 1) * 12) + 1;
        }

        return 440 * Math.pow(2, (key_number - 49) / 12);
    };

    /**
     * Lighten up man. Change the colour of a key.
     * @param  {element} el DOM element to change colour of.
     */
    var lightenUp = function lightenUp (el) {
        if (el !== null && typeof el !== 'undefined' && el.style) {
            el.style.backgroundColor = this.settings.activeColour;
        }
    };

    /**
     * Revert key to original colour.
     * @param  {element} el DOM element to change colour of.
     */
    var darkenDown = function darkenDown (el) {
        if (el !== null && typeof el !== 'undefined' && el.style) {
            if (el.getAttribute('data-note-type') === 'white') {
                el.style.backgroundColor = this.settings.whiteKeyColour;
            } else {
                el.style.backgroundColor = this.settings.blackKeyColour;
            }
        }
    };

    /**
     * Order notes into order defined by starting key in settings.
     * @param {array} notes_to_order Notes to be ordered.
     * @return {array} ordered_notes Ordered notes.
     */
    var orderNotes = function (settings, notes_to_order) {
        var i,
            keyOffset = 0,
            number_of_notes_to_order = notes_to_order.length,
            ordered_notes = [];

        for (i = 0; i < number_of_notes_to_order; i++) {
            if (settings.startNote.charAt(0) === notes_to_order[i]) {
                keyOffset = i;
                break;
            }
        }

        for (i = 0; i < number_of_notes_to_order; i++) {
            if (i + keyOffset > number_of_notes_to_order - 1) {
                ordered_notes[i] = notes_to_order[i + keyOffset - number_of_notes_to_order];
            } else {
                ordered_notes[i] = notes_to_order[i + keyOffset];
            }
        }

        return ordered_notes;
    };

    /**
     * Add styling to individual white key.
     * @param  {object} key White key definition.
     */
    var styleWhiteKey = function (self, key) {
        var settings = self.settings;
        key.el.style.backgroundColor = settings.whiteKeyColour;
        key.el.style.border = '1px solid ' + settings.borderColour;
        key.el.style.borderRight = 0;
        key.el.style.height = settings.height + 'px';
        key.el.style.width = key.width + 'px';
        key.el.style.borderRadius = '0 0 5px 5px';

        if (key.noteNumber === getTotalWhiteKeys(self) - 1) {
            key.el.style.border = '1px solid ' + settings.borderColour;
        }
    };

    /**
     * Add styling to individual black key.
     * @param  {object} key Black key definition.
     */
    var styleBlackKey = function (self, key) {
        var settings = self.settings,
            white_key_width = getWhiteKeyWidth(settings, getTotalWhiteKeys(self)),
            black_key_width = Math.floor(white_key_width / 2);

        key.el.style.backgroundColor = settings.blackKeyColour;
        key.el.style.border = '1px solid ' + settings.borderColour;
        key.el.style.position = 'absolute';
        key.el.style.left = Math.floor(((white_key_width + 1) * (key.noteNumber + 1)) - (black_key_width / 2)) + 'px';
        key.el.style.width = black_key_width + 'px';
        key.el.style.height = (settings.height / 1.5) + 'px';
        key.el.style.borderRadius = '0 0 3px 3px';
    };

    /**
    * Add styling to individual key on keyboard.
    * @param  {object} key Element of key.
    */
    var styleKey = function (self, key) {
        key.el.style.display = 'inline-block';
        key.el.style['-webkit-user-select'] = 'none';

        if (key.colour === 'white') {
            styleWhiteKey(self, key);
        } else {
            styleBlackKey(self, key);
        }
    };

    /**
    * Reset styles on keyboard container and list element.
    * @param {element} keyboard Keyboard container DOM element.
    */
    var styleKeyboard = function (self, keyboard) {
        var settings = self.settings,
            styleElement = function (el) {
                el.style.cursor = 'default';
                el.style.fontSize = '0px';
                el.style.height = settings.height + 'px';
                el.style.padding = 0;
                el.style.position = 'relative';
                el.style.listStyle = 'none';
                el.style.margin = 0;
                el.style.width = settings.width + 'px';
                el.style['-webkit-user-select'] = 'none';
            };

        styleElement(keyboard.container);
        styleElement(keyboard.el);
    };

    /**
     * Return the DOM element of a key if the event target is one.
     * @param  {element} target Event target.
     * @return {element|null} The key <li> or null.
     */
    var getKeyElement = function (target) {
        if (target && target.tagName && target.tagName.toLowerCase() === 'li') {
            return target;
        }
        return null;
    };

    /**
     * Create key DOM element.
     * @return {object} Key definition.
     */
    var createKey = function (self, key) {
        key.el = document.createElement('li');
        key.el.id = key.id;
        key.el.title = key.id;
        key.el.setAttribute('data-note-type', key.colour);

        styleKey(self, key);

        self._keyEls[key.id] = key.el;

        return key;
    };

    var getTotalWhiteKeys = function (self) {
        return self.settings.octaves * 7;
    };

    var createKeys = function (self) {
        var that = this,
            i,
            key,
            keys = [],
            note_counter = 0,
            octave_counter = self.settings.startOctave,
            total_white_keys = getTotalWhiteKeys(self),
            bizarre_note_counter;

        for (i = 0; i < total_white_keys; i++) {

            if (i % this.whiteNotes.length === 0) {
                note_counter = 0;
            }

            bizarre_note_counter = this.whiteNotes[note_counter];

            if ((bizarre_note_counter === 'C') && (i !== 0)) {
                octave_counter++;
            }

            key = createKey(self, {
                colour: 'white',
                octave: octave_counter,
                width: getWhiteKeyWidth(self.settings, total_white_keys),
                id: this.whiteNotes[note_counter] + octave_counter,
                noteNumber: i
            });

            keys.push(key.el);

            if (i !== total_white_keys - 1) {
                this.notesWithSharps.forEach(function (note) {
                    if (note === that.whiteNotes[note_counter]) {
                        key = createKey(self, {
                            colour: 'black',
                            octave: octave_counter,
                            width: getWhiteKeyWidth(self.settings, total_white_keys) / 2,
                            id: that.whiteNotes[note_counter] + '#' + octave_counter,
                            noteNumber: i
                        });

                        keys.push(key.el);
                    }
                });
            }
            note_counter++;
        }

        return keys;
    };

    var addKeysToKeyboard = function (keyboard) {
        keyboard.keys.forEach(function (key) {
            keyboard.el.appendChild(key);
        });
    };

    var setKeyPressOffset = function (self, sorted_white_notes) {
        self.settings.keyPressOffset = sorted_white_notes[0] === 'C' ? 0 : 1;
    };

    var createKeyboard = function (self) {
        var keyboard = {
            container: document.getElementById(self.settings.id),
            el: document.createElement('ul'),
            whiteNotes: orderNotes(self.settings, ['C', 'D', 'E', 'F', 'G', 'A', 'B']),
            notesWithSharps: orderNotes(self.settings, ['C', 'D', 'F', 'G', 'A'])
        };

        keyboard.keys = createKeys.call(keyboard, self);

        setKeyPressOffset(self, keyboard.whiteNotes);
        styleKeyboard(self, keyboard);

        // Add keys to keyboard, and keyboard to container.
        addKeysToKeyboard(keyboard);

        keyboard.container.appendChild(keyboard.el);

        return keyboard;
    };

    var getKeyPressed = function (self, keyCode) {
        return key_map[keyCode]
                .replace('l', parseInt(self.settings.startOctave, 10) + self.settings.keyPressOffset)
                .replace('u', (parseInt(self.settings.startOctave, 10) + self.settings.keyPressOffset + 1)
                .toString());
    };

    /**
     * Merge user settings with defaults.
     * @param  {object} user_settings
     */
    var init = function (user_settings) {
        var container;

        user_settings = user_settings || {};

        this.settings = {
            id:             user_settings.id || 'keyboard',
            octaves:        user_settings.octaves || 3,
            width:          user_settings.width,
            height:         user_settings.height,
            startNote:      user_settings.startNote || 'A3',
            whiteKeyColour: user_settings.whiteKeyColour || '#fff',
            blackKeyColour: user_settings.blackKeyColour || '#000',
            activeColour:   user_settings.activeColour || 'yellow',
            borderColour:   user_settings.borderColour || '#000',
            keyboardLayout: user_settings.keyboardLayout || 'en'
        };

        container = document.getElementById(this.settings.id);

        if (typeof this.settings.width === 'undefined') {
            this.settings.width = container.offsetWidth;
        }

        if (typeof this.settings.height === 'undefined') {
            this.settings.height = container.offsetHeight;
        }

        this.settings.startOctave = parseInt(this.settings.startNote.charAt(1), 10);

        this._keyboard = createKeyboard(this);
        this._container = container;
        addListeners(this, container);
    };

    /**
     * Add event listeners to keyboard.
     * @param {object} self Keyboard instance.
     * @param {element} keyboard_element
     */
    var addListeners = function (self, keyboard_element) {
        // Physical computer keyboard.
        self._onKeyDown = function (event) {
            keyboardDown(self, event);
        };
        self._onKeyUp = function (event) {
            keyboardUp(self, event);
        };
        globalWindow.addEventListener('keydown', self._onKeyDown);
        globalWindow.addEventListener('keyup', self._onKeyUp);

        // Mouse.
        self._onMouseDown = function (event) {
            mouseDown(self, event);
        };
        self._onMouseOver = function (event) {
            mouseOver(self, event);
        };
        self._onMouseOut = function (event) {
            mouseOut(self, event);
        };
        // The button can be released anywhere on the page, so listen on
        // document rather than only on the keyboard element.
        self._onDocumentMouseUp = function (event) {
            documentMouseUp(self, event);
        };

        keyboard_element.addEventListener('mousedown', self._onMouseDown);
        keyboard_element.addEventListener('mouseover', self._onMouseOver);
        keyboard_element.addEventListener('mouseout', self._onMouseOut);
        document.addEventListener('mouseup', self._onDocumentMouseUp);

        // Device supports touch events.
        if ('ontouchstart' in document.documentElement) {
            self._onTouchStart = function (event) {
                touchStart(self, event);
            };
            self._onTouchMove = function (event) {
                touchMove(self, event);
            };
            self._onTouchEnd = function (event) {
                touchEnd(self, event);
            };
            self._onTouchCancel = function (event) {
                touchCancel(self, event);
            };

            keyboard_element.addEventListener('touchstart', self._onTouchStart);
            keyboard_element.addEventListener('touchmove', self._onTouchMove);
            keyboard_element.addEventListener('touchend', self._onTouchEnd);
            keyboard_element.addEventListener('touchcancel', self._onTouchCancel);
        }
    };

    /* ------------------------------------------------------------------ *
     * Per-note source accounting.
     *
     * Every note keeps a map of currently pressed sources
     * ('mouse', 'keyboard', 'touch') and how many times each holds it.
     * keyDown is fired only when the first source presses the note,
     * keyUp only when the last source releases it.
     * ------------------------------------------------------------------ */

    var hasOwn = function (obj, prop) {
        return Object.prototype.hasOwnProperty.call(obj, prop);
    };

    var sourceCount = function (self, note) {
        var sources = self._noteSources[note],
            total = 0,
            source;
        if (!sources) {
            return 0;
        }
        for (source in sources) {
            if (hasOwn(sources, source)) {
                total += sources[source];
            }
        }
        return total;
    };

    /**
     * Press a note from the given input source.
     * No-op (no keyDown, no colour change) when the note is already held
     * by this or another source.
     */
    var noteDown = function (self, note, source) {
        var sources;

        if (!note) {
            return;
        }

        sources = self._noteSources[note];

        if (!sources) {
            sources = self._noteSources[note] = {};
            lightenUp.call(self, self._keyEls[note]);
            self.keyDown(note, getFrequencyOfNote(note));
        }

        sources[source] = (sources[source] || 0) + 1;
    };

    /**
     * Release a note from the given input source.
     * Fires keyUp and restores the colour only when the last source
     * holding the note is gone.
     */
    var noteUp = function (self, note, source) {
        var sources,
            any_left;

        if (!note) {
            return;
        }

        sources = self._noteSources[note];

        // This source never pressed the note (e.g. missed key-up): ignore.
        if (!sources || !sources[source]) {
            return;
        }

        sources[source] -= 1;

        if (sources[source] <= 0) {
            delete sources[source];
        }

        any_left = sourceCount(self, note) > 0;

        if (!any_left) {
            delete self._noteSources[note];
            darkenDown.call(self, self._keyEls[note]);
            self.keyUp(note, getFrequencyOfNote(note));
        }
    };

    /* ------------------------------------------------------------------ *
     * Mouse handling.
     * ------------------------------------------------------------------ */

    var mouseDown = function (self, event) {
        var el = getKeyElement(event.target);

        if (!el) {
            return;
        }

        self._mouseDown = true;
        self._mouseNote = el.title;
        noteDown(self, el.title, 'mouse');
    };

    var mouseOver = function (self, event) {
        var el;

        if (!self._mouseDown) {
            return;
        }

        el = getKeyElement(event.target);

        if (!el) {
            return;
        }

        // Glissando: leaving one key and entering another while the
        // button is held moves the mouse source between notes.
        if (self._mouseNote && self._mouseNote !== el.title) {
            noteUp(self, self._mouseNote, 'mouse');
        }

        self._mouseNote = el.title;
        noteDown(self, el.title, 'mouse');
    };

    var mouseOut = function (self, event) {
        var el = getKeyElement(event.target);

        if (!el || !self._mouseDown) {
            return;
        }

        // The pointer left the key while the button is still held.
        if (self._mouseNote === el.title) {
            noteUp(self, el.title, 'mouse');
            self._mouseNote = null;
        }
    };

    var documentMouseUp = function (self) {
        if (!self._mouseDown) {
            return;
        }

        self._mouseDown = false;

        if (self._mouseNote) {
            noteUp(self, self._mouseNote, 'mouse');
            self._mouseNote = null;
        }
    };

    /* ------------------------------------------------------------------ *
     * Physical keyboard handling.
     * ------------------------------------------------------------------ */

    /**
     * Handle a keyboard key being pressed.
     * @param {object} self Keyboard instance.
     * @param {object} key The keyboard event of the currently pressed key.
     */
    var keyboardDown = function (self, key) {
        var key_pressed;

        // Browser key auto-repeat and keys already held: do not retrigger.
        if (key.keyCode in self._keysDown) {
            return;
        }

        self._keysDown[key.keyCode] = true;

        if (typeof key_map[key.keyCode] !== 'undefined') {
            key_pressed = getKeyPressed(self, key.keyCode);
            noteDown(self, key_pressed, 'keyboard');
        }
    };

    /**
     * Handle a keyboard key being released.
     * @param {object} self Keyboard instance.
     * @param {object} key The keyboard event of the released key.
     */
    var keyboardUp = function (self, key) {
        var key_pressed;

        // Key-up without a matching key-down: nothing to release.
        if (!(key.keyCode in self._keysDown)) {
            return;
        }

        delete self._keysDown[key.keyCode];

        if (typeof key_map[key.keyCode] !== 'undefined') {
            key_pressed = getKeyPressed(self, key.keyCode);
            noteUp(self, key_pressed, 'keyboard');
        }
    };

    /* ------------------------------------------------------------------ *
     * Touch handling. Each finger is tracked separately so multitouch,
     * touch cancellation and dragged fingers cannot leave stuck notes.
     * ------------------------------------------------------------------ */

    var forEachChangedTouch = function (event, handler) {
        var i,
            touches = event.changedTouches || [];

        for (i = 0; i < touches.length; i++) {
            handler(touches[i]);
        }
    };

    /**
     * Locate the key a touch started on (or is ending on). The touch's
     * own target is the most reliable source for touchstart/touchend/
     * touchcancel; coordinate hit-testing is only needed while moving.
     */
    var keyElementFromTouchTarget = function (touch) {
        return getKeyElement(touch.target);
    };

    /**
     * Locate the key currently under a moving touch. Its original target
     * does not follow the finger, so hit-test the live coordinates and
     * fall back to the target when hit-testing is unavailable.
     */
    var keyElementUnderTouch = function (touch) {
        var el = null;

        if (typeof document.elementFromPoint === 'function') {
            el = document.elementFromPoint(touch.clientX, touch.clientY);
        }
        if (!el) {
            el = touch.target;
        }
        return getKeyElement(el);
    };

    var touchStart = function (self, event) {
        event.preventDefault();

        forEachChangedTouch(event, function (touch) {
            var el;

            // A finger identifier is unique from touchstart to touchend.
            // A second touchstart with the same id is a stale/duplicate
            // event and must not double-count the note.
            if (hasOwn(self._touchedNotes, touch.identifier)) {
                return;
            }

            el = keyElementFromTouchTarget(touch);

            if (!el) {
                return;
            }

            self._touchedNotes[touch.identifier] = el.title;
            noteDown(self, el.title, 'touch');
        });
    };

    var touchMove = function (self, event) {
        event.preventDefault();

        forEachChangedTouch(event, function (touch) {
            var oldNote = self._touchedNotes[touch.identifier],
                el,
                newNote;

            if (typeof oldNote === 'undefined') {
                return;
            }

            el = keyElementUnderTouch(touch);
            newNote = el ? el.title : null;

            if (newNote !== oldNote) {
                noteUp(self, oldNote, 'touch');
                if (newNote) {
                    noteDown(self, newNote, 'touch');
                }
                self._touchedNotes[touch.identifier] = newNote;
            }
        });
    };

    var releaseTouch = function (self, event) {
        forEachChangedTouch(event, function (touch) {
            var note = self._touchedNotes[touch.identifier];

            if (typeof note === 'undefined' || note === null) {
                return;
            }

            delete self._touchedNotes[touch.identifier];
            noteUp(self, note, 'touch');
        });
    };

    var touchEnd = function (self, event) {
        event.preventDefault();
        releaseTouch(self, event);
    };

    var touchCancel = function (self, event) {
        event.preventDefault();
        releaseTouch(self, event);
    };

    /**
     * Qwerty Hancock constructor.
     * @param {object} settings Optional user settings.
     */
    var QwertyHancock = function (settings) {
        this.version = version;

        this.keyDown = function () {
            // Placeholder function.
        };

        this.keyUp = function () {
            // Placeholder function.
        };

        // Per-instance state: two keyboards never share press state.
        this._noteSources = {};   // note -> { source: count }
        this._keyEls = {};        // note -> DOM element
        this._keysDown = {};      // keyCode -> true (physical keyboard)
        this._mouseDown = false;
        this._mouseNote = null;
        this._touchedNotes = {};  // touch identifier -> note
        this._destroyed = false;

        try {
            init.call(this, settings);
        } catch (e) {
            // A partially constructed keyboard must not leave listeners
            // (e.g. when the container element does not exist).
            this.destroy();
            throw e;
        }
    };

    /**
     * Tear the keyboard down: remove every listener, release any notes
     * that are still held (one keyUp each) and remove the generated DOM.
     */
    QwertyHancock.prototype.destroy = function () {
        var note,
            container = this._container,
            keyboard = this._keyboard;

        if (this._destroyed) {
            return;
        }
        this._destroyed = true;

        if (this._onKeyDown) {
            globalWindow.removeEventListener('keydown', this._onKeyDown);
        }
        if (this._onKeyUp) {
            globalWindow.removeEventListener('keyup', this._onKeyUp);
        }
        if (this._onDocumentMouseUp) {
            document.removeEventListener('mouseup', this._onDocumentMouseUp);
        }

        if (container) {
            if (this._onMouseDown) {
                container.removeEventListener('mousedown', this._onMouseDown);
            }
            if (this._onMouseOver) {
                container.removeEventListener('mouseover', this._onMouseOver);
            }
            if (this._onMouseOut) {
                container.removeEventListener('mouseout', this._onMouseOut);
            }
            if (this._onTouchStart) {
                container.removeEventListener('touchstart', this._onTouchStart);
            }
            if (this._onTouchMove) {
                container.removeEventListener('touchmove', this._onTouchMove);
            }
            if (this._onTouchEnd) {
                container.removeEventListener('touchend', this._onTouchEnd);
            }
            if (this._onTouchCancel) {
                container.removeEventListener('touchcancel', this._onTouchCancel);
            }
        }

        // Release notes still held so no key stays lit / voice rings on.
        for (note in this._noteSources) {
            if (hasOwn(this._noteSources, note)) {
                darkenDown.call(this, this._keyEls[note]);
                this.keyUp(note, getFrequencyOfNote(note));
            }
        }
        this._noteSources = {};
        this._keysDown = {};
        this._touchedNotes = {};
        this._mouseDown = false;
        this._mouseNote = null;

        if (keyboard && keyboard.el && container && container.contains(keyboard.el)) {
            container.removeChild(keyboard.el);
        }
    };

    if (typeof exports !== 'undefined') {
      if (typeof module !== 'undefined' && module.exports) {
        exports = module.exports = QwertyHancock;
      }
      exports.QwertyHancock = QwertyHancock;
    } else {
      root.QwertyHancock = QwertyHancock;
    }
}).call(this);
