/*
 * Author: Michael van der Kamp
 *
 * This file defines the CanvasSequenceError, thrown by CanvasSequence.execute
 * when one of the instructions in a sequence fails while being replayed.
 *
 * The error preserves the original failure as its `cause`, and carries the
 * position and identity of the instruction that failed so that callers can
 * diagnose what went wrong without losing the original error.
 */

'use strict';

/**
 * A CanvasSequenceError is thrown when a CanvasSequence cannot be fully
 * replayed on a canvas context. It reports which instruction failed and at
 * what index in the sequence, while keeping the underlying error available
 * through the standard `cause` property.
 *
 * When the failure occurred while unwinding an unbalanced save/restore stack
 * (i.e. during the cleanup that pairs the sequence's own outer save), the
 * error raised by `restore()` is exposed separately as `restoreError` rather
 * than replacing the original execution error.
 */
class CanvasSequenceError extends Error {
  /**
   * @param {object} details
   * @param {number} details.index - Zero-based index of the failed atom.
   * @param {string} details.inst - The context instruction that failed.
   * @param {string} details.type - The kind of atom ('method' or 'property').
   * @param {Error} details.cause - The original error thrown during replay.
   * @param {Error} [details.restoreError] - An error thrown while restoring
   *   the saved canvas state during cleanup, if any.
   */
  constructor({ index, inst, type, cause, restoreError = undefined }) {
    super(
      `CanvasSequence execution failed at instruction ${index} `
      + `(${type} "${inst}"): ${cause.message}`,
      { cause },
    );

    /**
     * Zero-based index of the instruction that failed within the sequence.
     *
     * @type {number}
     */
    this.index = index;

    /**
     * Name of the canvas context instruction that failed.
     *
     * @type {string}
     */
    this.inst = inst;

    /**
     * Type of the failing instruction, either CanvasAtom.METHOD ('method') or
     * CanvasAtom.PROPERTY ('property').
     *
     * @type {string}
     */
    this.type = type;

    /**
     * The error raised by `context.restore()` while unwinding the saved
     * state, if cleanup itself failed. The original execution error remains
     * the primary error (and the `cause`).
     *
     * @type {Error|undefined}
     */
    this.restoreError = restoreError;

    this.name = 'CanvasSequenceError';
  }
}

module.exports = CanvasSequenceError;
