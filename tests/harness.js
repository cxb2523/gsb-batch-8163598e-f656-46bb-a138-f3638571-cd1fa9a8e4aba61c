'use strict';
// Loads src/game.js into a vm sandbox on top of the mini world and exposes
// the game internals the scenarios drive.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { makeSandbox } = require('./dom-stub');
const { buildData } = require('./mini-data');

const GAME_JS = path.join(__dirname, '..', 'src', 'game.js');

function loadGame() {
  const D = buildData();
  const sandbox = makeSandbox(D);
  vm.createContext(sandbox);
  const code = fs.readFileSync(GAME_JS, 'utf8');
  vm.runInContext(code, sandbox, { filename: 'src/game.js' });
  if (!sandbox.window || !sandbox.window.__game) throw new Error('game.js did not expose window.__game');
  return sandbox.window.__game;
}

// ---- tiny assertion framework ---------------------------------------------
let passed = 0, failed = 0;
const failures = [];
function check(cond, label) {
  if (cond) { passed++; }
  else { failed++; failures.push(label); console.error('  FAIL: ' + label); }
}
function eq(actual, expected, label) {
  check(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { process.exitCode = 1; }
  return failed === 0;
}

module.exports = { loadGame, check, eq, report };
