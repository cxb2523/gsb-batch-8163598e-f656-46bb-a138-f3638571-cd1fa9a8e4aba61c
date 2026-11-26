/* ===================================================
 * 浏览器控制台样例 — 每日结算完整链路
 * ---------------------------------------------------
 * 用法：
 *   1. 用浏览器打开本仓库的 index.html（进入游戏页面即可）；
 *   2. 打开 DevTools 控制台，把本文件全部内容粘贴进去回车；
 *   3. 观察 ✓/✗ 输出；结束后游戏现场（地块/玩家/背包）会还原。
 *
 * 也可以直接打开 tests/day-cycle.html 查看图形化测试结果。
 *
 * 覆盖：
 *   - 连续两日浇水，作物阶段递增直至成熟
 *   - 漏浇一日不生长（浇一 → 漏一 → 再浇）
 *   - advanceDay() 结算后所有土壤变干
 *   - 收获后 crop / watered / type 状态清空
 *   - 浇水粒子落在目标地块中心；非土壤不耗冷却、不出粒子
 * =================================================== */

(function () {

    "use strict";

    if (typeof World === "undefined" || typeof Player === "undefined") {

        console.error("[day-cycle] 未找到 World / Player，请先在游戏页面 index.html 的控制台运行本样例。");
        return;

    }

    var TILE = (typeof TILE_SIZE !== "undefined") ? TILE_SIZE : 32;

    // ---------- 保存现场，结束后还原 ----------
    var saved = {

        tiles: World.tiles,
        day: World.day,

        px: Player.x,
        py: Player.y,
        pw: Player.width,
        ph: Player.height,
        facing: Player.facing,
        cooldown: Player.toolCooldown,

        items: (typeof Inventory !== "undefined") ? Inventory.items.slice() : null,

        particles: (typeof ParticleManager !== "undefined") ? ParticleManager.particles.slice() : null

    };

    var failures = [];
    var passes = 0;

    function ok(condition, name, detail) {

        if (condition) {

            passes += 1;
            console.log("%c  ✓ " + name, "color:#51cf66");

        } else {

            failures.push(name);
            console.error("  ✗ " + name + (detail ? "  -> " + detail : ""));

        }

    }

    function eq(actual, expected, name) {

        ok(

            actual === expected,
            name,
            "期望 " + JSON.stringify(expected) + "，实际 " + JSON.stringify(actual)

        );

    }

    // ---------- 构造隔离的 3x3 地块 ----------
    // Player 位于 (TILE, 0)、朝 down 时，面对的是 tiles[1][1]，
    // 该格中心的世界坐标为 (1.5*TILE, 1.5*TILE) = (48, 48)。
    function installGrid() {

        var tiles = [];

        for (var r = 0; r < 3; r++) {

            tiles[r] = [];

            for (var c = 0; c < 3; c++) {

                tiles[r][c] = {

                    row: r,
                    col: c,
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

        if (typeof ParticleManager !== "undefined") {

            ParticleManager.particles.length = 0;

        }

        return tiles;

    }

    function target(tiles) { return tiles[1][1]; }

    function waterToday(tile) {

        Player.toolCooldown = 0;
        Player.waterTile();

        return tile.watered === true;

    }

    try {

        console.group("%c🌾 每日结算链路样例", "font-weight:bold;font-size:14px");

        // ---------- 1. 连续两日浇水：阶段递增 ----------
        console.group("1) 连续两日浇水，作物阶段递增");

        var tiles = installGrid();
        var tile = target(tiles);
        var maxStage = CropRegistry.carrot.growthStages - 1;

        tile.crop = { cropId: "carrot", stage: 0, wateredDays: 0 };

        ok(waterToday(tile), "第 1 天浇水后 tile.watered === true");
        World.advanceDay();

        eq(tile.crop.stage, 1, "第 1 次结算后 stage: 0 -> 1");
        eq(tile.watered, false, "结算后当日湿润标记被清除");

        ok(waterToday(tile), "第 2 天再次浇水成功");
        World.advanceDay();

        eq(tile.crop.stage, 2, "第 2 次结算后 stage: 1 -> 2（成熟）");
        eq(tile.crop.wateredDays, 2, "已浇水天数累计为 2");
        ok(tile.crop.stage <= maxStage, "阶段不超过生长注册表上限 " + maxStage);

        console.groupEnd();

        // ---------- 2. 漏浇一日不生长 ----------
        console.group("2) 漏浇一日不生长（浇一 → 漏一 → 再浇）");

        tiles = installGrid();
        tile = target(tiles);
        tile.crop = { cropId: "carrot", stage: 0, wateredDays: 0 };

        tile.watered = true;
        World.advanceDay();
        eq(tile.crop.stage, 1, "浇水日结算后 stage -> 1");

        World.advanceDay(); // 完全不浇水
        eq(tile.crop.stage, 1, "漏浇日结算后 stage 保持 1");

        tile.watered = true;
        World.advanceDay();
        eq(tile.crop.stage, 2, "再次浇水并结算后 stage -> 2");

        console.groupEnd();

        // ---------- 3. 结算后所有土壤变干 ----------
        console.group("3) advanceDay() 后所有地块变干");

        tiles = installGrid();
        tiles[0][0].watered = true;
        tiles[0][2].watered = true;
        tiles[2][1].watered = true;
        tiles[2][2].watered = true;

        World.advanceDay();

        var allDry = true;

        for (var r = 0; r < tiles.length; r++) {

            for (var c = 0; c < tiles[r].length; c++) {

                if (tiles[r][c].watered !== false) { allDry = false; }

            }

        }

        ok(allDry, "3x3 地块在一次结算后 watered 全部为 false");
        eq(World.day, 2, "World.day 从 1 推进到 2");

        console.groupEnd();

        // ---------- 4. 成熟封顶 + 收获清空 ----------
        console.group("4) 成熟作物封顶 & 收获后状态清空");

        tiles = installGrid();
        tile = target(tiles);
        tile.watered = true;
        tile.crop = { cropId: "carrot", stage: maxStage, wateredDays: 2 };

        World.advanceDay();
        eq(tile.crop.stage, maxStage, "成熟后再结算仍为最终阶段 " + maxStage);
        eq(tile.watered, false, "成熟作物所在土壤结算后同样变干");

        tile.watered = true; // 收获前保持湿润，验证收获会一并清空
        Player.toolCooldown = 0;
        Player.harvestCrop();

        eq(tile.crop, null, "收获后 tile.crop === null");
        eq(tile.watered, false, "收获后 tile.watered === false");
        eq(tile.type, "soil", "收获后 tile.type 仍为 soil");

        if (typeof Inventory !== "undefined") {

            var gotCarrot = Inventory.items.some(function (i) {

                return i.id === "carrot" && i.amount >= 1;

            });

            ok(gotCarrot, "收获物 carrot 已进入 Inventory");

        }

        console.groupEnd();

        // ---------- 5. 浇水粒子位置 / 非土壤冷却 ----------
        console.group("5) 浇水反馈修正（粒子位置 + 冷却条件）");

        if (typeof ParticleManager === "undefined") {

            console.warn("  ! 未加载 ParticleManager，跳过粒子断言");

        } else {

            // 5a. 土壤：粒子必须出现在目标格中心 (48,48)
            tiles = installGrid();
            tile = target(tiles);

            var calls = [];
            var originalSpawn = ParticleManager.spawn;
            ParticleManager.spawn = function (x, y, color, count) {

                calls.push({ x: x, y: y, color: color, count: count });

            };

            Player.toolCooldown = 0;
            Player.waterTile();

            ParticleManager.spawn = originalSpawn;

            eq(calls.length, 1, "对土壤浇水触发 1 次粒子生成");

            if (calls.length === 1) {

                eq(calls[0].x, TILE + TILE / 2, "粒子 x = 目标格中心 x");
                eq(calls[0].y, TILE + TILE / 2, "粒子 y = 目标格中心 y（不是玩家脚下的 16）");

            }

            ok(Player.toolCooldown === Player.toolDelay, "成功浇水进入冷却");

            // 5b. 非土壤（草地）：无粒子、无冷却
            tiles = installGrid();
            tile = target(tiles);
            tile.type = "grass";

            var nonSoilCalls = 0;
            ParticleManager.spawn = function () { nonSoilCalls += 1; };

            Player.toolCooldown = 0;
            Player.waterTile();

            ParticleManager.spawn = originalSpawn;

            eq(nonSoilCalls, 0, "对草地浇水不生成粒子");
            eq(Player.toolCooldown, 0, "对草地浇水不消耗冷却");

        }

        console.groupEnd();

        // ---------- 6. 帧更新不再按 Date.now 生长 ----------
        console.group("6) World.update 不再用真实时间覆盖阶段");

        tiles = installGrid();
        tile = target(tiles);
        tile.watered = true;
        tile.crop = { cropId: "carrot", stage: 0 };

        for (var i = 0; i < 600; i++) { World.update(16); }
        World.update(60000);

        eq(tile.crop.stage, 0, "大量帧更新后 stage 仍为 0（只由 advanceDay 推进）");

        console.groupEnd();

    } catch (error) {

        failures.push("样例执行抛出异常: " + error.message);
        console.error(error);

    } finally {

        // ---------- 还原游戏现场 ----------
        World.tiles = saved.tiles;
        World.day = saved.day;

        Player.x = saved.px;
        Player.y = saved.py;
        Player.width = saved.pw;
        Player.height = saved.ph;
        Player.facing = saved.facing;
        Player.toolCooldown = saved.cooldown;

        if (saved.items && typeof Inventory !== "undefined") {

            Inventory.items = saved.items;

        }

        if (saved.particles && typeof ParticleManager !== "undefined") {

            ParticleManager.particles = saved.particles;

        }

    }

    var summary = {

        passed: passes,
        failed: failures.length,
        failures: failures,
        ok: failures.length === 0

    };

    window.__dayCycleConsoleResult = summary;

    if (summary.ok) {

        console.log(

            "%c🌾 全部通过：" + passes + " 项断言 ✓（游戏现场已还原）",
            "color:#51cf66;font-weight:bold;font-size:13px"

        );

    } else {

        console.error(

            "🌾 " + failures.length + " 项失败 / " + passes +
            " 项通过：" + JSON.stringify(failures, null, 2)

        );

    }

    return summary;

})();
