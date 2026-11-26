// ===================================================
// WORLD
// Handles world generation, tile utilities,
// collision queries and crop updates.
// ===================================================

const World = {

    // ===================================================
    // WORLD DATA
    // ===================================================

    tiles: [],
    buildings: [],
    farmObjects: [],
    fences: [],

    // Current in-game day. Day settlement advances this by one.
    day: 1,

    spawn: {

        x: 0,
        y: 0

    },

    // ===================================================
    // INITIALIZATION
    // ===================================================

    init() {

        this.buildings = [];
        this.farmObjects = [];
        this.fences = [];

        this.day = 1;

        this.tiles = WorldGenerator.generate();

    },

    // ===================================================
    // TILE UTILITIES
    // ===================================================

    isWalkable(tile) {

        if (!tile) {
            return false;
        }

        // Water blocks movement
        if (tile.type === "water") {
            return false;
        }

        // Trees block movement
        if (tile.tree) {

            const treeData = TreeRegistry[tile.tree.id];

            if (treeData && treeData.solid) {
                return false;
            }

        }

        return true;

    },

    worldToTile(x, y) {

        return {

            row: Math.floor(y / TILE_SIZE),
            col: Math.floor(x / TILE_SIZE)

        };

    },

    tileToWorld(row, col) {

        return {

            x: col * TILE_SIZE,
            y: row * TILE_SIZE

        };

    },

    // ===================================================
    // COLLISION HELPERS
    // ===================================================

    rectanglesOverlap(a, b) {

        return (

            a.x < b.x + b.width &&
            a.x + a.width > b.x &&
            a.y < b.y + b.height &&
            a.y + a.height > b.y

        );

    },

    // ===================================================
    // BUILDING COLLISION
    // ===================================================

    isCollidingWithBuildings(rect) {

        for (const building of this.buildings) {

            const data = BuildingRegistry[building.id];

            if (!data || !data.collision) {
                continue;
            }

            const box = {

                x: building.x + data.collision.x,
                y: building.y + data.collision.y,

                width: data.collision.width,
                height: data.collision.height

            };

            if (this.rectanglesOverlap(rect, box)) {
                return true;
            }

        }

        return false;

    },

    // ===================================================
    // FARM OBJECT COLLISION
    // ===================================================

    isCollidingWithFarmObjects(rect) {

        for (const object of this.farmObjects) {

            const data = FarmObjectRegistry[object.id];

            if (!data || !data.collision) {
                continue;
            }

            const box = {

                x: object.x + data.collision.x,
                y: object.y + data.collision.y,

                width: data.collision.width,
                height: data.collision.height

            };

            if (this.rectanglesOverlap(rect, box)) {
                return true;
            }

        }

        return false;

    },

    // ===================================================
    // FENCE COLLISION
    // ===================================================

    isCollidingWithFences(rect) {

        for (const fence of this.fences) {

            if (!fence.collision) {
                continue;
            }

            const box = {

                x: fence.x,
                y: fence.y,

                width: TILE_SIZE,
                height: TILE_SIZE

            };

            if (this.rectanglesOverlap(rect, box)) {
                return true;
            }

        }

        return false;

    },

    // ===================================================
    // DAY SETTLEMENT
    // ===================================================

    // Single entry point for advancing to the next in-game day.
    //
    // Rules:
    //   1. A crop grows exactly one stage only when its tile was
    //      watered during the day being settled.
    //   2. Crops on unwatered tiles do not change.
    //   3. Mature crops stay at their final stage (never overflow).
    //   4. After growth is resolved, every tile dries out, so watering
    //      is only valid for the current day.
    //
    // Growth is based on accumulated watered days, never on Date.now().
    advanceDay() {

        let grownCrops = 0;
        let wateredTiles = 0;

        const rowCount = this.tiles.length;

        for (let row = 0; row < rowCount; row++) {

            const tileRow = this.tiles[row];

            if (!tileRow) {
                continue;
            }

            for (let col = 0; col < tileRow.length; col++) {

                const tile = tileRow[col];

                if (!tile) {
                    continue;
                }

                // Resolve growth BEFORE clearing today's watering flag.
                if (tile.crop && tile.watered) {

                    const crop = tile.crop;

                    // Count every settled day the crop had water.
                    crop.wateredDays =
                        (Number.isFinite(crop.wateredDays)
                            ? crop.wateredDays
                            : 0) + 1;

                    const cropData =
                        typeof CropRegistry !== "undefined"
                            ? CropRegistry[crop.cropId]
                            : null;

                    const maxStage = cropData
                        ? cropData.growthStages - 1
                        : (Number.isInteger(crop.maxStage)
                            ? crop.maxStage
                            : crop.stage);

                    if (crop.stage < maxStage) {

                        crop.stage += 1;
                        grownCrops += 1;

                    }

                }

                if (tile.watered) {
                    wateredTiles += 1;
                }

                // Watering only lasts for the current day.
                tile.watered = false;

            }

        }

        this.day += 1;

        return {

            day: this.day,
            grownCrops: grownCrops,
            wateredTiles: wateredTiles

        };

    },

    // ===================================================
    // WORLD UPDATE
    // ===================================================

    update(deltaTime) {

        // Crop growth is resolved by the daily settlement
        // (World.advanceDay), not by real elapsed time. This per-frame
        // hook is intentionally kept (the game loop calls it) but must
        // never overwrite crop.stage from Date.now()/deltaTime.

    }

};

// ===================================================
// TEST / TOOLING EXPORTS
// Mirror the global binding onto globalThis so Node vm contexts and
// require()-based local tests can reach it. No effect on gameplay.
// ===================================================

if (typeof globalThis !== "undefined") {

    globalThis.World = World;

}

if (typeof module !== "undefined" && module.exports) {

    module.exports = World;
    module.exports.World = World;

}