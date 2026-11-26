// ===================================================
// UTILITIES
// Shared helper functions used throughout the engine.
// ===================================================

// ===================================================
// TILE HELPERS
// ===================================================

function getTileAt(x, y) {

    const col = Math.floor(x / TILE_SIZE);
    const row = Math.floor(y / TILE_SIZE);

    // -----------------------------------------------
    // World Bounds Check
    // -----------------------------------------------

    if (
        row < 0 ||
        row >= WORLD_ROWS ||
        col < 0 ||
        col >= WORLD_COLS
    ) {
        return null;
    }

    return World.tiles[row][col];

}

// ===================================================
// PLAYER HELPERS
// ===================================================

function getPlayerTile() {

    return World.worldToTile(

        Player.x + Player.width / 2,
        Player.y + Player.height / 2

    );

}

// Test/tooling bridge: when sources are loaded one file per Node module,
// publish these shared helpers as globals. No gameplay effect.
if (typeof globalThis !== "undefined") {

    globalThis.getTileAt = getTileAt;
    globalThis.getPlayerTile = getPlayerTile;

}

if (typeof module !== "undefined" && module.exports) {

    module.exports = { getTileAt: getTileAt, getPlayerTile: getPlayerTile };

}