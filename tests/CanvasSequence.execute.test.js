/*
 * Tests for the failure handling and save/restore pairing guarantees of
 * CanvasSequence.execute, and for the CanvasSequenceError it reports.
 */

/* global jest, describe, test, expect */

'use strict';

const {
  CanvasSequence,
  CanvasSequenceError,
} = require('../index.js');
const CanvasAtom = require('../src/CanvasAtom.js');

/**
 * Build a mock canvas context whose save/restore calls maintain a stack
 * depth, so that pairing correctness can be asserted.
 *
 * @param {object} [overrides] - Method implementations to replace defaults.
 */
function createMockContext(overrides = {}) {
  let depth = 0;
  const calls = [];

  const defaults = {
    'save': () => {
      depth += 1;
      calls.push('save');
    },
    'restore': () => {
      calls.push('restore');
      if (depth === 0) {
        throw new Error('restore() called without a matching save()');
      }
      depth -= 1;
    },
    'beginPath': () => calls.push('beginPath'),
    'arc': () => calls.push('arc'),
    'fillRect': () => calls.push('fillRect'),
    'closePath': () => calls.push('closePath'),
  };

  const ctx = {};
  Object.entries({ ...defaults, ...overrides }).forEach(([name, impl]) => {
    ctx[name] = jest.fn(impl);
  });

  return {
    ctx,
    calls,
    'getDepth': () => depth,
  };
}

describe('CanvasSequence.execute error handling', () => {
  describe('normal replay', () => {
    test('saves once before and restores once after the instructions', () => {
      // Given
      const { ctx, calls, getDepth } = createMockContext();
      const cs = new CanvasSequence();
      cs.beginPath();
      cs.arc(0, 1, 2, 3, Math.PI);
      cs.fillRect(4, 5, 6, 7);

      // When
      cs.execute(ctx);

      // Then
      expect(ctx.save).toHaveBeenCalledTimes(1);
      expect(ctx.restore).toHaveBeenCalledTimes(1);
      expect(calls[0]).toBe('save');
      expect(calls[calls.length - 1]).toBe('restore');
      expect(getDepth()).toBe(0);
      expect(calls.slice(1, -1)).toEqual(['beginPath', 'arc', 'fillRect']);
    });

    test('does not throw when every instruction succeeds', () => {
      // Given
      const { ctx } = createMockContext();
      const cs = new CanvasSequence();
      cs.fillRect(1, 2, 3, 4);

      // Then
      expect(() => cs.execute(ctx)).not.toThrow();
    });

    test('pairs an internally balanced save/restore with one outer restore', () => {
      // Given
      const { ctx, getDepth } = createMockContext();
      const cs = new CanvasSequence();
      cs.save();
      cs.beginPath();
      cs.restore();
      cs.fillRect(0, 0, 1, 1);

      // When
      cs.execute(ctx);

      // Then
      expect(ctx.save).toHaveBeenCalledTimes(2);
      expect(ctx.restore).toHaveBeenCalledTimes(2);
      expect(getDepth()).toBe(0);
    });
  });

  describe('when an instruction throws', () => {
    test('restores exactly once and rethrows a catchable CanvasSequenceError', () => {
      // Given
      const originalError = new TypeError('arc is not a function');
      const { ctx } = createMockContext({
        'arc': () => { throw originalError; },
      });
      const cs = new CanvasSequence();
      cs.beginPath();
      cs.arc(0, 1, 2, 3, Math.PI);
      cs.fillRect(4, 5, 6, 7);

      // When / Then
      let caught;
      try {
        cs.execute(ctx);
      }
      catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(CanvasSequenceError);
      expect(caught).toBeInstanceOf(Error);
      expect(caught.index).toBe(1);
      expect(caught.inst).toBe('arc');
      expect(caught.type).toBe(CanvasAtom.METHOD);
      expect(caught.cause).toBe(originalError);
      expect(caught.restoreError).toBeUndefined();
      expect(caught.message).toContain('arc');
      expect(caught.message).toContain('1');

      // Cleanup ran exactly once and the stack ended balanced.
      expect(ctx.save).toHaveBeenCalledTimes(1);
      expect(ctx.restore).toHaveBeenCalledTimes(1);

      // Instructions before the failure ran, instructions after did not.
      expect(ctx.beginPath).toHaveBeenCalledTimes(1);
      expect(ctx.fillRect).not.toHaveBeenCalled();
    });

    test('reports a failing property assignment with its index and type', () => {
      // Given
      const propertyError = new Error('illegal assignment');
      const { ctx } = createMockContext();
      Object.defineProperty(ctx, 'fillStyle', {
        'configurable': true,
        'enumerable': true,
        'get': () => 'black',
        'set': () => { throw propertyError; },
      });
      const cs = new CanvasSequence();
      cs.beginPath();
      cs.fillStyle = 'blue';

      // When
      let caught;
      try {
        cs.execute(ctx);
      }
      catch (error) {
        caught = error;
      }

      // Then
      expect(caught).toBeInstanceOf(CanvasSequenceError);
      expect(caught.index).toBe(1);
      expect(caught.inst).toBe('fillStyle');
      expect(caught.type).toBe(CanvasAtom.PROPERTY);
      expect(caught.cause).toBe(propertyError);
      expect(ctx.restore).toHaveBeenCalledTimes(1);
    });

    test('keeps the original error as cause when restore also throws', () => {
      // Given
      const originalError = new Error('bad arc arguments');
      const restoreError = new Error('restore failed');
      const { ctx } = createMockContext({
        'arc': () => { throw originalError; },
        'restore': () => { throw restoreError; },
      });
      const cs = new CanvasSequence();
      cs.beginPath();
      cs.arc(0, 0, 1, 0, Math.PI);

      // When
      let caught;
      try {
        cs.execute(ctx);
      }
      catch (error) {
        caught = error;
      }

      // Then: the execution error remains the primary cause, the cleanup
      // failure is exposed alongside it rather than replacing it.
      expect(caught).toBeInstanceOf(CanvasSequenceError);
      expect(caught.cause).toBe(originalError);
      expect(caught.restoreError).toBe(restoreError);
      expect(caught.index).toBe(1);
      expect(caught.inst).toBe('arc');
      expect(ctx.restore).toHaveBeenCalledTimes(1);
    });

    test('propagates a restore failure on the normal path unchanged', () => {
      // Given
      const restoreError = new Error('restore failed');
      const { ctx } = createMockContext({
        'restore': () => { throw restoreError; },
      });
      const cs = new CanvasSequence();
      cs.beginPath();

      // When
      let caught;
      try {
        cs.execute(ctx);
      }
      catch (error) {
        caught = error;
      }

      // Then: no instruction failed, so the restore error is not wrapped.
      expect(caught).toBe(restoreError);
      expect(caught).not.toBeInstanceOf(CanvasSequenceError);
    });
  });

  describe('nested save/restore instructions', () => {
    test('unwinds an unclosed internal save so the outer restore stays paired', () => {
      // Given
      const originalError = new Error('arc exploded');
      const { ctx, getDepth } = createMockContext({
        'arc': () => { throw originalError; },
      });
      const cs = new CanvasSequence();
      cs.save(); // internal, never closed by the sequence
      cs.beginPath();
      cs.arc(0, 0, 1, 0, Math.PI);

      // When
      let caught;
      try {
        cs.execute(ctx);
      }
      catch (error) {
        caught = error;
      }

      // Then: one restore for the internal save, one for the outer save.
      expect(caught).toBeInstanceOf(CanvasSequenceError);
      expect(caught.cause).toBe(originalError);
      expect(caught.index).toBe(2);
      expect(caught.inst).toBe('arc');
      expect(ctx.save).toHaveBeenCalledTimes(2);
      expect(ctx.restore).toHaveBeenCalledTimes(2);
      expect(getDepth()).toBe(0);
    });

    test('unwinds several unclosed internal saves in reverse order', () => {
      // Given
      const originalError = new Error('fillRect exploded');
      const { ctx, getDepth } = createMockContext({
        'fillRect': () => { throw originalError; },
      });
      const cs = new CanvasSequence();
      cs.save();
      cs.save();
      cs.beginPath();
      cs.fillRect(0, 0, 1, 1);

      // When
      let caught;
      try {
        cs.execute(ctx);
      }
      catch (error) {
        caught = error;
      }

      // Then: two internal saves plus the outer save require three restores.
      expect(caught).toBeInstanceOf(CanvasSequenceError);
      expect(caught.index).toBe(3);
      expect(ctx.restore).toHaveBeenCalledTimes(3);
      expect(getDepth()).toBe(0);
    });

    test('only does the outer restore when internal saves are already closed', () => {
      // Given
      const originalError = new Error('arc exploded');
      const { ctx, getDepth } = createMockContext({
        'arc': () => { throw originalError; },
      });
      const cs = new CanvasSequence();
      cs.save();
      cs.beginPath();
      cs.restore(); // internal pair closed before the failure
      cs.arc(0, 0, 1, 0, Math.PI);

      // When
      let caught;
      try {
        cs.execute(ctx);
      }
      catch (error) {
        caught = error;
      }

      // Then
      expect(caught).toBeInstanceOf(CanvasSequenceError);
      expect(caught.index).toBe(3);
      expect(ctx.restore).toHaveBeenCalledTimes(2);
      expect(getDepth()).toBe(0);
    });

    test('still attempts every restore when cleanup itself fails', () => {
      // Given
      const originalError = new Error('arc exploded');
      const restoreError = new Error('restore exploded');
      const { ctx } = createMockContext({
        'arc': () => { throw originalError; },
        'restore': () => { throw restoreError; },
      });
      const cs = new CanvasSequence();
      cs.save(); // unclosed internal save
      cs.arc(0, 0, 1, 0, Math.PI);

      // When
      let caught;
      try {
        cs.execute(ctx);
      }
      catch (error) {
        caught = error;
      }

      // Then: the internal save and the outer save both get a restore
      // attempt, and the original execution error stays the primary cause.
      expect(caught).toBeInstanceOf(CanvasSequenceError);
      expect(caught.cause).toBe(originalError);
      expect(caught.restoreError).toBe(restoreError);
      expect(ctx.restore).toHaveBeenCalledTimes(2);
    });
  });

  describe('CanvasSequenceError', () => {
    test('exposes the failure position, instruction details, and cause', () => {
      // Given
      const cause = new Error('boom');
      const error = new CanvasSequenceError({
        'index': 4,
        'inst': 'lineTo',
        'type': CanvasAtom.METHOD,
        cause,
      });

      // Then
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('CanvasSequenceError');
      expect(error.index).toBe(4);
      expect(error.inst).toBe('lineTo');
      expect(error.type).toBe('method');
      expect(error.cause).toBe(cause);
      expect(error.restoreError).toBeUndefined();
      expect(error.message).toContain('4');
      expect(error.message).toContain('lineTo');
      expect(error.message).toContain('boom');
    });

    test('optionally carries the restore failure separately', () => {
      // Given
      const cause = new Error('boom');
      const restoreError = new Error('cleanup boom');

      // When
      const error = new CanvasSequenceError({
        'index': 0,
        'inst': 'save',
        'type': CanvasAtom.METHOD,
        cause,
        restoreError,
      });

      // Then
      expect(error.cause).toBe(cause);
      expect(error.restoreError).toBe(restoreError);
    });
  });
});
