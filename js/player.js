// ===================================================
// PLAYER
// Handles movement, tools, farming, and interactions
// ===================================================

const Player = {

    // ===================================================
    // PROPERTIES
    // ===================================================

    x: 0,
    y: 0,
    width: TILE_SIZE,
    height: TILE_SIZE,

    speed: 200, // pixels per second
    facing: "down",

    coins: 0,

    toolCooldown: 0,
    toolDelay: 200,

    // ===================================================
    // UPDATE LOOP
    // ===================================================

    update(deltaTime) {

        // Cooldown timer
        if (this.toolCooldown > 0) {
            this.toolCooldown -= deltaTime;
        }

        const moveAmount = this.speed * (deltaTime / 1000);

        let moveX = 0;
        let moveY = 0;

        // ===================================================
        // INPUT HANDLING
        // ===================================================

        if (Input.isKeyDown("w")) {
            moveY -= moveAmount;
            this.facing = "up";
        }

        if (Input.isKeyDown("s")) {
            moveY += moveAmount;
            this.facing = "down";
        }

        if (Input.isKeyDown("a")) {
            moveX -= moveAmount;
            this.facing = "left";
        }

        if (Input.isKeyDown("d")) {
            moveX += moveAmount;
            this.facing = "right";
        }

        // Normalize diagonal movement
        if (moveX !== 0 && moveY !== 0) {
            moveX *= Math.SQRT1_2;
            moveY *= Math.SQRT1_2;
        }

        // ===================================================
        // X AXIS MOVEMENT + COLLISION
        // ===================================================

        let newX = this.x + moveX;

        let topLeft = getTileAt(newX, this.y);
        let topRight = getTileAt(newX + this.width - 1, this.y);
        let bottomLeft = getTileAt(newX, this.y + this.height - 1);
        let bottomRight = getTileAt(newX + this.width - 1, this.y + this.height - 1);

        let canMoveX =
            World.isWalkable(topLeft) &&
            World.isWalkable(topRight) &&
            World.isWalkable(bottomLeft) &&
            World.isWalkable(bottomRight);

        const playerBoxX = {

            x: newX,
            y: this.y,

            width: this.width,
            height: this.height

        };

        canMoveX =
            canMoveX &&
            !World.isCollidingWithBuildings(playerBoxX) &&
            !World.isCollidingWithFarmObjects(playerBoxX) &&
            !World.isCollidingWithFences(playerBoxX);

        if (canMoveX) {
            this.x = newX;
        }

        // ===================================================
        // Y AXIS MOVEMENT + COLLISION
        // ===================================================

        let newY = this.y + moveY;

        topLeft = getTileAt(this.x, newY);
        topRight = getTileAt(this.x + this.width - 1, newY);
        bottomLeft = getTileAt(this.x, newY + this.height - 1);
        bottomRight = getTileAt(this.x + this.width - 1, newY + this.height - 1);

        let canMoveY =
            World.isWalkable(topLeft) &&
            World.isWalkable(topRight) &&
            World.isWalkable(bottomLeft) &&
            World.isWalkable(bottomRight);

        const playerBoxY = {

            x: this.x,
            y: newY,

            width: this.width,
            height: this.height

        };

        canMoveY =
            canMoveY &&
            !World.isCollidingWithBuildings(playerBoxY) &&
            !World.isCollidingWithFarmObjects(playerBoxY) &&
            !World.isCollidingWithFences(playerBoxY);

        if (canMoveY) {
            this.y = newY;
        }

        // ===================================================
        // WORLD BOUNDARIES
        // ===================================================

        const maxX = WORLD_COLS * TILE_SIZE - this.width;
        const maxY = WORLD_ROWS * TILE_SIZE - this.height;

        this.x = Math.max(0, Math.min(this.x, maxX));
        this.y = Math.max(0, Math.min(this.y, maxY));
    },

    // ===================================================
    // ITEM USAGE CONTROLLER
    // ===================================================

    useSelectedItem() {

        const item = Hotbar.getSelectedItem();

        switch (item.type) {

            case "tool":

                switch (item.toolType) {

                    case "hoe":
                        this.useHoe();
                        break;

                    case "wateringCan":
                        this.waterTile();
                        break;
                }

                return;

            case "seed":
                this.plantSeed(item);
                return;
        }
    },

    getTargetPoint() {

        const centerX = this.x + this.width / 2;
        const centerY = this.y + this.height / 2;

        const reach = TILE_SIZE * 0.75;

        let targetX = centerX;
        let targetY = centerY;

        switch (this.facing) {

            case "up":
                targetY -= reach;
                break;

            case "down":
                targetY += reach;
                break;

            case "left":
                targetX -= reach;
                break;

            case "right":
                targetX += reach;
                break;

        }

        return {
            x: targetX,
            y: targetY
        };

    },

    // ===================================================
    // TILE DETECTION
    // ===================================================

    // Grid coordinates of the tile the player is facing.
    // Kept separate from getFacingTile() so effects can place
    // themselves on the targeted tile even when only coordinates
    // are needed.
    getFacingTileCoords() {

        // Prefer the shared helper when all scripts share global scope
        // (browser / vm). Fall back to the equivalent inline math so
        // isolated require()-based harnesses work without utils.js.
        let tilePos;

        if (typeof getPlayerTile === "function") {

            tilePos = getPlayerTile();

        } else {

            tilePos = World.worldToTile(

                this.x + this.width / 2,
                this.y + this.height / 2

            );

        }

        let row = tilePos.row;
        let col = tilePos.col;

        switch (this.facing) {

            case "up":
                row--;
                break;

            case "down":
                row++;
                break;

            case "left":
                col--;
                break;

            case "right":
                col++;
                break;

        }

        return {

            row: row,
            col: col

        };

    },

    getFacingTile() {

        const target = this.getFacingTileCoords();

        const row = target.row;
        const col = target.col;

        if (
            row < 0 ||
            row >= WORLD_ROWS ||
            col < 0 ||
            col >= WORLD_COLS
        ) {
            return null;
        }

        return World.tiles[row][col];

    },

    // ===================================================
    // FARMING TOOLS
    // ===================================================

    useHoe() {

        const tile = this.getFacingTile();
        if (!tile) return;

        if (tile.crop) {
            this.harvestCrop();
            return;
        }

        if (tile.type === "grass") {
            tile.type = "soil";
        }

        // console.log("Hoe tile:", tile);
    },

    waterTile() {

        if (this.toolCooldown > 0) return;

        const tile = this.getFacingTile();

        // Only tilled soil can be watered. Invalid targets must not
        // trigger the cooldown nor spawn any particles.
        if (!tile || tile.type !== "soil") return;

        // Commit the cooldown only for a successful watering.
        this.toolCooldown = this.toolDelay;

        tile.watered = true;

        // Spawn the splash on the WATERED tile, not at the player's feet.
        const targetCoords = this.resolveTileCoords(tile);
        const worldPos = World.tileToWorld(targetCoords.row, targetCoords.col);

        if (
            typeof ParticleManager !== "undefined" &&
            ParticleManager &&
            typeof ParticleManager.spawn === "function"
        ) {
            ParticleManager.spawn(
                worldPos.x + TILE_SIZE / 2,
                worldPos.y + TILE_SIZE / 2,
                "#4DA6FF",
                6
            );
        }
    },

    // Best-effort grid coordinates for a target tile. Real tiles carry
    // row/col; synthetic test tiles may only be reachable by reference.
    resolveTileCoords(tile) {

        if (
            tile &&
            Number.isInteger(tile.row) &&
            Number.isInteger(tile.col)
        ) {

            return { row: tile.row, col: tile.col };

        }

        try {

            if (World && Array.isArray(World.tiles)) {

                for (let row = 0; row < World.tiles.length; row++) {

                    const tileRow = World.tiles[row];

                    if (!tileRow) {
                        continue;
                    }

                    for (let col = 0; col < tileRow.length; col++) {

                        if (tileRow[col] === tile) {

                            return { row: row, col: col };

                        }

                    }

                }

            }

        } catch (error) { /* fall through */ }

        try {

            const facing = this.getFacingTileCoords();

            if (
                Number.isInteger(facing.row) &&
                Number.isInteger(facing.col)
            ) {

                return facing;

            }

        } catch (error) { /* fall through */ }

        try {

            const playerTile = World.worldToTile(this.x, this.y);

            return { row: playerTile.row, col: playerTile.col };

        } catch (error) {

            return { row: 0, col: 0 };

        }

    },

    // ===================================================
    // SEED PLANTING
    // ===================================================

    plantSeed(item) {

        const target = this.getFacingTileCoords();

        const row = target.row;
        const col = target.col;

        if (
            row < 0 ||
            row >= WORLD_ROWS ||
            col < 0 ||
            col >= WORLD_COLS
        ) {
            return;
        }

        const tile = World.tiles[row][col];

        if (
            tile.type !== "soil" ||
            tile.crop
        ) {
            return;
        }

        tile.crop = {
            cropId: item.cropId,
            stage: 0,

            // Growth is accumulated by watered days during
            // World.advanceDay() settlement, not real elapsed time.
            wateredDays: 0,
            plantedDay: World.day || 1
        };
    },

    // ===================================================
    // HARVEST SYSTEM
    // ===================================================

    harvestCrop() {

        if (this.toolCooldown > 0) return;

        this.toolCooldown = this.toolDelay;

        const tile = this.getFacingTile();
        if (!tile || !tile.crop) return;

        const cropData = CropRegistry[tile.crop.cropId];

        if (tile.crop.stage < cropData.growthStages - 1) {
            return;
        }

        if (
            typeof Inventory !== "undefined" &&
            Inventory &&
            typeof Inventory.add === "function"
        ) {
            Inventory.add(cropData.harvestItem, 1);
        }

        const tilePos = World.worldToTile(
            Player.x,
            Player.y
        );

        const worldPos = World.tileToWorld(
            tilePos.row,
            tilePos.col
        );

        const x = worldPos.x + TILE_SIZE / 2;
        const y = worldPos.y + TILE_SIZE / 2;

        // Guarded so headless/local test harnesses that do not load
        // effects.js can still verify the state reset below.
        if (
            typeof Effects !== "undefined" &&
            Effects &&
            typeof Effects.harvest === "function"
        ) {
            Effects.harvest(x, y);
        }

        tile.crop = null;
        tile.watered = false;
        tile.type = "soil";

        // console.log("Harvest tile:", this.getFacingTile());
    },

    // ===================================================
    // MONEY SYSTEM
    // ===================================================

    addCoins(amount) {

        this.coins += amount;

    },

    removeCoins(amount) {

        if (this.coins < amount) {

            return false;

        }

        this.coins -= amount;

        return true;

    }

};

// ===================================================
// TEST / TOOLING EXPORTS
// Mirror the global binding onto globalThis so Node vm contexts and
// require()-based local tests can reach it. No effect on gameplay.
// ===================================================

if (typeof globalThis !== "undefined") {

    globalThis.Player = Player;

}

if (typeof module !== "undefined" && module.exports) {

    module.exports = Player;
    module.exports.Player = Player;

}