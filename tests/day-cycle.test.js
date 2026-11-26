// ===================================================
// NODE TESTS — DAILY SETTLEMENT CHAIN
// ---------------------------------------------------
// Runs without npm install. The game is vanilla JS whose source
// files share browser-style globals (top-level consts), so we load
// the relevant files into one shared Node `vm` context — the closest
// equivalent to ordered <script> tags.
//
// Run directly:
//   node tests/day-cycle.test.js
// or via the built-in runner:
//   node --test tests/
// ===================================================

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const { runDayCycleChecks } = require("./day-cycle.checks.js");

const repoRoot = path.resolve(__dirname, "..");

// Sources needed by the day-cycle / watering / harvest paths,
// in the same dependency order as index.html.
const sourceFiles = [

    "js/constants.js",
    "js/cropRegistry.js",
    "js/utils.js",
    "js/world.js",
    "js/inventory.js",
    "js/particleManager.js",
    "js/effects.js",
    "js/player.js"

];

function loadGameContext() {

    const sandbox = {

        console: console,

        // Some sources defensively inspect `module`; leave it
        // undefined inside the vm so the browser-global branch runs.
        setTimeout: setTimeout,
        clearTimeout: clearTimeout

    };

    // vm contexts already provide their own standard built-ins
    // (Object, Array, Math, JSON, Date, ...).
    vm.createContext(sandbox);

    for (const relativePath of sourceFiles) {

        const absolutePath = path.join(repoRoot, relativePath);
        const source = fs.readFileSync(absolutePath, "utf8");

        vm.runInContext(source, sandbox, { filename: relativePath });

    }

    return sandbox;

}

const sandbox = loadGameContext();

// The source files publish themselves onto globalThis, which is the
// vm sandbox global object.
const env = {

    World: sandbox.World,
    Player: sandbox.Player,
    CropRegistry: sandbox.CropRegistry,
    ParticleManager: sandbox.ParticleManager,
    Inventory: sandbox.Inventory,
    TILE_SIZE: sandbox.TILE_SIZE,
    WORLD_ROWS: sandbox.WORLD_ROWS

};

assert.ok(env.World, "World should be exposed by js/world.js");
assert.ok(env.Player, "Player should be exposed by js/player.js");
assert.ok(env.CropRegistry, "CropRegistry should be exposed by js/cropRegistry.js");

const report = runDayCycleChecks(env);

// Register one node:test case per acceptance check.
for (const result of report.results) {

    test(result.name, () => {

        if (!result.ok) {

            assert.fail(result.message + "\n" + (result.stack || ""));

        }

    });

}

test("day-cycle suite has no failures (" + report.passed + "/" + report.total + " passed)", () => {

    assert.equal(report.failed, 0, "all day-cycle checks should pass");

});
