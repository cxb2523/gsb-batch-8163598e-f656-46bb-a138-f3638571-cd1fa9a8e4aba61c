// ===================================================
// DAY CYCLE CHECKS
// ---------------------------------------------------
// Environment-agnostic acceptance checks for the daily
// settlement (World.advanceDay) and the watering fix
// (Player.waterTile).
//
// Usable from:
//   - Node:        required by tests/day-cycle.test.js
//   - Browser:     loaded by tests/day-cycle.html
//
// The caller passes an `env` object holding the live globals:
//   { World, Player, CropRegistry, ParticleManager, Inventory }
// ===================================================

(function (root, factory) {

    if (typeof module === "object" && module.exports) {

        module.exports = factory();

    } else {

        root.DayCycleChecks = factory();

    }

})(typeof globalThis !== "undefined" ? globalThis : this, function () {

    "use strict";

    function runDayCycleChecks(env) {

        const World = env.World;
        const Player = env.Player;
        const CropRegistry = env.CropRegistry;
        const ParticleManager = env.ParticleManager || null;
        const Inventory = env.Inventory || null;

        const TILE = env.TILE_SIZE || 32;

        const results = [];

        function check(id, name, fn) {

            try {

                fn();
                results.push({ id: id, name: name, ok: true });

            } catch (error) {

                results.push({

                    id: id,
                    name: name,
                    ok: false,
                    message: error && error.message
                        ? error.message
                        : String(error),
                    stack: error && error.stack ? error.stack : null

                });

            }

        }

        function assert(condition, message) {

            if (!condition) {

                throw new Error(message || "assertion failed");

            }

        }

        function eq(actual, expected, message) {

            if (actual !== expected) {

                throw new Error(

                    (message || "strict equality") +
                    " | expected: " + JSON.stringify(expected) +
                    ", actual: " + JSON.stringify(actual)

                );

            }

        }

        // ---------------------------------------------------
        // FIXTURES
        // ---------------------------------------------------

        // Installs a fresh 3x3 grid. With Player at (TILE, 0)
        // facing "down", the faced tile is grid[1][1], whose
        // center in world coordinates is (1.5*TILE, 1.5*TILE).
        function installGrid() {

            const tiles = [];

            for (let row = 0; row < 3; row++) {

                tiles[row] = [];

                for (let col = 0; col < 3; col++) {

                    tiles[row][col] = {

                        row: row,
                        col: col,
                        type: "soil",
                        watered: false,
                        crop: null

                    };

                }

            }

            World.tiles = tiles;
            World.day = 1;

            Player.x = TILE;
            Player.y = 0;
            Player.width = TILE;
            Player.height = TILE;
            Player.facing = "down";
            Player.toolCooldown = 0;

            if (ParticleManager && Array.isArray(ParticleManager.particles)) {

                ParticleManager.particles.length = 0;

            }

            return tiles;

        }

        function targetTile(tiles) {

            return tiles[1][1];

        }

        function maxStageFor(cropId) {

            return CropRegistry[cropId].growthStages - 1;

        }

        // Waters through the real Player entry point and clears the
        // cooldown the way the frame loop would between days.
        function waterToday(tile) {

            Player.toolCooldown = 0;
            Player.waterTile();
            assert(tile.watered === true, "waterTile should mark the tile watered");

        }

        // ---------------------------------------------------
        // A1 — Watered soil dries after advancing a day
        // ---------------------------------------------------

        check("A1-direct-dries", "[A1] advanceDay() dries a watered tile", function () {

            const tiles = installGrid();
            const tile = tiles[0][0];

            tile.watered = true;

            const summary = World.advanceDay();

            eq(tile.watered, false, "tile.watered after advanceDay");
            eq(World.day, 2, "day counter after one advanceDay");
            assert(summary && typeof summary === "object", "advanceDay should return a summary");

        });

        check("A1-player-chain", "[A1] waterTile() -> advanceDay() leaves the tile dry", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            eq(tile.watered, false, "precondition: dry tile");

            Player.toolCooldown = 0;
            Player.waterTile();

            eq(tile.watered, true, "tile becomes watered after waterTile");

            World.advanceDay();

            eq(tile.watered, false, "tile dries after advanceDay");

        });

        check("settlement-dries-all", "[P4] Every tile is dry after settlement", function () {

            const tiles = installGrid();

            tiles[0][0].watered = true;
            tiles[0][1].watered = true;
            tiles[1][0].watered = true;
            tiles[2][2].watered = true;

            World.advanceDay();

            for (let row = 0; row < tiles.length; row++) {

                for (let col = 0; col < tiles[row].length; col++) {

                    eq(

                        tiles[row][col].watered,
                        false,
                        "tile " + row + "," + col + " should be dry"

                    );

                }

            }

        });

        // ---------------------------------------------------
        // A2 — Two consecutive watered days -> stage increases
        // ---------------------------------------------------

        check("A2-two-watered-days", "[A2] Watering on two consecutive days increments stage twice", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);
            const maxStage = maxStageFor("carrot");

            tile.crop = { cropId: "carrot", stage: 0, wateredDays: 0 };

            const stage0 = tile.crop.stage;

            // Day 1: water then settle.
            waterToday(tile);
            World.advanceDay();

            const stage1 = tile.crop.stage;

            eq(tile.watered, false, "soil is dry after day 1 settlement");
            assert(stage1 > stage0, "stage should increase after the first watered day");
            eq(stage1, 1, "stage after one watered day");
            eq(tile.crop.wateredDays, 1, "wateredDays after one watered day");

            // Day 2: water again then settle.
            waterToday(tile);
            World.advanceDay();

            const stage2 = tile.crop.stage;

            assert(stage2 > stage1, "stage should increase again after the second watered day");
            eq(stage2, 2, "stage after two watered days");
            eq(tile.crop.wateredDays, 2, "wateredDays after two watered days");
            assert(stage2 <= maxStage, "stage must not exceed the registry maximum");

        });

        // ---------------------------------------------------
        // A3 — Missing a watering day -> no growth
        // ---------------------------------------------------

        check("A3-missed-day", "[A3] No watering on a day means no stage change", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            tile.crop = { cropId: "carrot", stage: 0, wateredDays: 0 };

            // No watering at all, just settle.
            World.advanceDay();

            eq(tile.crop.stage, 0, "unwatered crop must not grow");
            eq(tile.crop.wateredDays, 0, "unwatered crop wateredDays stays 0");

        });

        check("A3-water-skip-resume", "[A3] Water, skip a day, then water again: 1 -> 1 -> 2", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            tile.crop = { cropId: "carrot", stage: 0, wateredDays: 0 };

            // Watered day.
            tile.watered = true;
            World.advanceDay();
            eq(tile.crop.stage, 1, "stage after watered day");

            // Missed day.
            World.advanceDay();
            eq(tile.crop.stage, 1, "stage unchanged after missed day");

            // Watered again.
            tile.watered = true;
            World.advanceDay();
            eq(tile.crop.stage, 2, "stage advances on the next watered day");

        });

        // ---------------------------------------------------
        // A4 — Mature crops stay mature
        // ---------------------------------------------------

        check("A4-mature-clamp", "[A4] A mature crop stays at the final stage", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);
            const maxStage = maxStageFor("carrot");

            tile.crop = { cropId: "carrot", stage: maxStage };

            for (let day = 0; day < 3; day++) {

                tile.watered = true;
                World.advanceDay();

                eq(tile.crop.stage, maxStage, "mature stage must stay clamped");
                assert(

                    tile.crop.stage <= CropRegistry.carrot.growthStages - 1,
                    "stage index must stay valid for the renderer"

                );

            }

        });

        // ---------------------------------------------------
        // A5 — Harvest clears crop + soil state
        // ---------------------------------------------------

        check("A5-harvest-clears", "[A5] Harvesting a mature crop clears crop/water and keeps soil", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            tile.type = "soil";
            tile.watered = true;
            tile.crop = { cropId: "carrot", stage: maxStageFor("carrot"), wateredDays: 2 };

            Player.toolCooldown = 0;
            Player.harvestCrop();

            eq(tile.crop, null, "tile.crop should be null after harvest");
            eq(tile.watered, false, "tile.watered should be false after harvest");
            eq(tile.type, "soil", "tile.type should remain soil after harvest");

            if (Inventory) {

                const harvested = Inventory.items.some(function (item) {

                    return item.id === CropRegistry.carrot.harvestItem && item.amount >= 1;

                });

                assert(harvested, "harvested produce should be in the inventory");

            }

        });

        check("A5-immature-no-harvest", "[regression] Immature crops cannot be harvested", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            tile.crop = { cropId: "carrot", stage: 0 };

            Player.toolCooldown = 0;
            Player.harvestCrop();

            assert(tile.crop !== null, "immature crop must remain on the tile");
            eq(tile.crop.stage, 0, "immature stage unchanged");

        });

        // ---------------------------------------------------
        // A6 — Watering particles + cooldown validity
        // ---------------------------------------------------

        check("A6-soil-particles-on-target", "[A6] Splash particles spawn at the watered tile center", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            eq(tile.type, "soil", "precondition: target is soil");

            const expectedX = 1 * TILE + TILE / 2;
            const expectedY = 1 * TILE + TILE / 2;

            let spawnCall = null;
            let originalSpawn = null;

            if (ParticleManager) {

                originalSpawn = ParticleManager.spawn;

                ParticleManager.spawn = function (x, y, color, count) {

                    spawnCall = { x: x, y: y, color: color, count: count };

                };

            }

            try {

                Player.toolCooldown = 0;
                Player.waterTile();

            } finally {

                if (ParticleManager && originalSpawn) {

                    ParticleManager.spawn = originalSpawn;

                }

            }

            assert(spawnCall, "ParticleManager.spawn should be called for soil");
            eq(spawnCall.x, expectedX, "particle x is the target tile center x");
            eq(spawnCall.y, expectedY, "particle y is the target tile center y");

            // The old bug used the player's own tile: with Player at
            // (TILE, 0) its center is (1.5*TILE, 0.5*TILE), so the y
            // coordinate must differ from the player-center y.
            const playerCenterTileY = 0 * TILE + TILE / 2;
            assert(

                spawnCall.y !== playerCenterTileY,
                "particles must not spawn at the player's feet"

            );

            eq(Player.toolCooldown, Player.toolDelay, "successful watering starts the cooldown");

        });

        check("A6-non-soil-no-cooldown-no-particles", "[A6] Watering non-soil spends no cooldown and no particles", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            tile.type = "grass";

            let spawnCount = 0;
            let originalSpawn = null;

            if (ParticleManager) {

                originalSpawn = ParticleManager.spawn;
                ParticleManager.spawn = function () { spawnCount += 1; };

            }

            try {

                Player.toolCooldown = 0;
                Player.waterTile();

            } finally {

                if (ParticleManager && originalSpawn) {

                    ParticleManager.spawn = originalSpawn;

                }

            }

            eq(spawnCount, 0, "no particles for non-soil target");
            eq(Player.toolCooldown, 0, "cooldown must not be consumed by non-soil target");
            eq(tile.watered, false, "non-soil tile is not marked watered");

        });

        check("A6-null-tile-no-cooldown", "[A6] Watering while facing out of bounds does nothing", function () {

            installGrid();

            // Put the player at the bottom edge so facing "down" is OOB.
            Player.x = 0;
            Player.y = env.WORLD_ROWS * TILE;
            Player.toolCooldown = 0;

            let spawnCount = 0;
            let originalSpawn = null;

            if (ParticleManager) {

                originalSpawn = ParticleManager.spawn;
                ParticleManager.spawn = function () { spawnCount += 1; };

            }

            try {

                Player.waterTile();

            } finally {

                if (ParticleManager && originalSpawn) {

                    ParticleManager.spawn = originalSpawn;

                }

            }

            eq(spawnCount, 0, "no particles for out-of-bounds target");
            eq(Player.toolCooldown, 0, "no cooldown for out-of-bounds target");

        });

        // ---------------------------------------------------
        // End-to-end chain: plant -> water x2 -> settle -> harvest
        // ---------------------------------------------------

        check("e2e-full-chain", "[E2E] Plant, water two days, settle to mature, harvest clears all", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            Player.plantSeed({ cropId: "carrot" });

            assert(tile.crop, "seed should be planted");
            eq(tile.crop.stage, 0, "new crop starts at stage 0");
            eq(tile.crop.wateredDays, 0, "new crop starts with 0 watered days");

            for (let day = 0; day < 2; day++) {

                Player.toolCooldown = 0;
                Player.waterTile();
                World.advanceDay();

            }

            eq(tile.crop.stage, maxStageFor("carrot"), "crop should be mature after two watered days");

            Player.toolCooldown = 0;
            Player.harvestCrop();

            eq(tile.crop, null, "crop cleared after full chain harvest");
            eq(tile.watered, false, "watered flag cleared after harvest");
            eq(tile.type, "soil", "tile remains soil after harvest");

        });

        // ---------------------------------------------------
        // Regression: frame update must not grow via Date.now
        // ---------------------------------------------------

        check("regression-update-no-realtime-growth", "[regression] World.update never advances stages by real time", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            tile.watered = true;
            tile.crop = { cropId: "carrot", stage: 0 };

            // Simulate a long stretch of frame updates.
            for (let i = 0; i < 600; i++) {

                World.update(16);

            }

            World.update(60000);

            eq(tile.crop.stage, 0, "frame updates must not grow crops; only advanceDay does");
            eq(tile.watered, true, "World.update must not dry tiles either");

        });

        // ---------------------------------------------------
        // Regression: hoe + collision basics stay intact
        // ---------------------------------------------------

        check("regression-hoe-grass-to-soil", "[regression] Hoe still turns grass into soil", function () {

            const tiles = installGrid();
            const tile = targetTile(tiles);

            tile.type = "grass";
            tile.crop = null;

            Player.useHoe();

            eq(tile.type, "soil", "hoe on grass should create soil");

        });

        check("regression-collision-basics", "[regression] isWalkable keeps water/empty rules", function () {

            eq(World.isWalkable(null), false, "null tile is not walkable");
            eq(World.isWalkable({ type: "water" }), false, "water is not walkable");
            eq(World.isWalkable({ type: "grass" }), true, "grass is walkable");
            eq(World.isWalkable({ type: "soil" }), true, "soil is walkable");

        });

        // ---------------------------------------------------
        // Report
        // ---------------------------------------------------

        const passed = results.filter(function (r) { return r.ok; }).length;
        const failed = results.length - passed;

        return {

            results: results,
            total: results.length,
            passed: passed,
            failed: failed,
            ok: failed === 0

        };

    }

    return { runDayCycleChecks: runDayCycleChecks };

});
