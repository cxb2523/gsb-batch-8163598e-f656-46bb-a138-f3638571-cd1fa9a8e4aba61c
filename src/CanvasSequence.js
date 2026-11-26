/*
 * Author: Michael van der Kamp
 *
 * This file provides the definition of the CanvasSequence class.
 */

'use strict';

const CanvasAtom = require('./CanvasAtom.js');
const CanvasSequenceError = require('./CanvasSequenceError.js');
const instructions = require('./CanvasInstructions.js');

// Mark properties as intended for internal use.
const symbols = Object.freeze({
  'sequence': Symbol.for('sequence'),
  'push': Symbol.for('push'),
  'fromJSON': Symbol.for('fromJSON'),
});

/**
 * A CanvasSequence is a linear collection of CanvasAtoms, capable of being
 * executed on a CanvasRenderingContext2D.
 *
 * @param {CanvasSequence} [data=null] - An unrevived (i.e. freshly transmitted)
 * CanvasSequence. If present, the constructor revives the sequence. Note that
 * an already revived CanvasSequence cannot be used as the argument here.
 */
class CanvasSequence {
  constructor(data = null) {
    /**
     * The CanvasAtoms that form the sequence.
     *
     * @private
     * @type {CanvasAtom[]}
     */
    this[symbols.sequence] = [];

    // If data is present, assume it is a CanvasSequence that needs reviving.
    if (data) {
      this[symbols.fromJSON](data);
    }
  }

  /**
   * Revive the sequence from transmitted JSON data.
   *
   * @private
   * @param {CanvasSequence} [data={}]
   */
  [symbols.fromJSON](data = { 'sequence': [] }) {
    data.sequence.forEach(({ type, inst, args }) => {
      this[symbols.push](type, inst, args);
    });
  }

  /**
   * Push a new CanvasAtom onto the end of the sequence.
   *
   * @private
   * @param {string} type - The type of CanvasAtom to push.
   * @param {string} inst - The canvas context instruction.
   * @param {*[]} args - The arguments to the canvas context instruction.
   */
  [symbols.push](type, inst, args) {
    this[symbols.sequence].push(new CanvasAtom(type, inst, args));
  }

  /**
   * Execute the sequence on the given context.
   *
   * The context state is always saved before replay and restored afterwards,
   * exactly once on the normal path. If an instruction throws mid-sequence,
   * any save/restore pairs opened inside the sequence are first unwound so
   * that the final restore pairs with the initial save, and a
   * CanvasSequenceError is thrown carrying the failing instruction's index,
   * name, and type, with the original error as its `cause`. Already executed
   * instructions are not rolled back, since the canvas does not support it.
   *
   * @param {CanvasRenderingContext2D} context
   * @throws {CanvasSequenceError} If an instruction fails during replay.
   */
  execute(context) {
    context.save();

    const sequence = this[symbols.sequence];

    // Depth of save/restore pairs opened by instructions within the sequence
    // itself. Tracked so that an unbalanced internal save cannot make the
    // outer restore pop the wrong state (or underflow the stack).
    let internalDepth = 0;
    let executionError = null;
    let failedAtom = null;
    let failedIndex = -1;

    try {
      for (failedIndex = 0; failedIndex < sequence.length; failedIndex += 1) {
        const atom = sequence[failedIndex];
        atom.execute(context);

        if (atom.inst === 'save') {
          internalDepth += 1;
        }
        else if (atom.inst === 'restore' && internalDepth > 0) {
          internalDepth -= 1;
        }
      }
    }
    catch (error) {
      executionError = error;
      failedAtom = sequence[failedIndex];
    }

    if (executionError === null) {
      // Normal path: the sequence was internally balanced, so a single
      // restore pairs with the save above. A failure here propagates as-is.
      context.restore();
      return;
    }

    // Exception path: unwind every internal save still open, then restore
    // the state saved at the top of this method. The outer restore runs
    // exactly once; internal restores only close the sequence's own saves.
    let restoreError = null;
    for (let r = internalDepth; r >= 0; r -= 1) {
      try {
        context.restore();
      }
      catch (error) {
        // Keep the original execution error as the primary cause; report
        // the cleanup failure alongside it instead of replacing it.
        if (restoreError === null) {
          restoreError = error;
        }
      }
    }

    throw new CanvasSequenceError({
      'index': failedIndex,
      'inst': failedAtom.inst,
      'type': failedAtom.type,
      'cause': executionError,
      'restoreError': restoreError ?? undefined,
    });
  }

  /**
   * Export a JSON serialized version of the sequence, ready for transmission.
   *
   * @return {CanvasSequence} In JSON serialized form.
   */
  toJSON() {
    return { 'sequence': this[symbols.sequence] };
  }
}

instructions.METHODS.forEach((m) => {
  Object.defineProperty(CanvasSequence.prototype, m, {
    'value': function pushMethodCall(...args) {
      this[symbols.push](CanvasAtom.METHOD, m, args);
    },
    'writable': false,
    'enumerable': true,
    'configurable': false,
  });
});

instructions.PROPERTIES.forEach((p) => {
  Object.defineProperty(CanvasSequence.prototype, p, {
    get() { throw `Invalid canvas sequencer interaction, cannot get ${p}.`; },
    set(v) { this[symbols.push](CanvasAtom.PROPERTY, p, [v]); },
    'enumerable': true,
    'configurable': false,
  });
});

module.exports = CanvasSequence;
