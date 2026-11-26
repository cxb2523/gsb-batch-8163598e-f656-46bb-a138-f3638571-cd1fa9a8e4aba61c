// ===================================================
// CONFIGURATION
// Global engine constants.
// ===================================================

// ===================================================
// CANVAS
// ===================================================

const GAME_WIDTH = 1280;
const GAME_HEIGHT = 720;

// ===================================================
// WORLD
// ===================================================

const TILE_SIZE = 32;

const WORLD_ROWS = 100;
const WORLD_COLS = 100;

// ===================================================
// ENGINE
// ===================================================

const TARGET_FPS = 60;

// Test/tooling bridge: makes these file-scoped constants resolvable as
// globals when sources are loaded one file per Node module. In the
// browser these are already shared lexical bindings.
if (typeof globalThis !== "undefined") {

    Object.assign(globalThis, {

        GAME_WIDTH,
        GAME_HEIGHT,
        TILE_SIZE,
        WORLD_ROWS,
        WORLD_COLS,
        TARGET_FPS

    });

}
