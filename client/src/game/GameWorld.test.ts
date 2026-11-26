import { describe, expect, it, vi } from "vitest";
import { GameWorld } from "./GameWorld";
import { RunGate } from "./runGate";
import type { GameCallbacks, HudSnapshot } from "./types";

/** No-op 2D context: every drawing method is a spy-less function; gradients return a stub. */
function createMockCtx(): CanvasRenderingContext2D {
  const gradient = { addColorStop() { /* no-op */ } };
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "createLinearGradient") return () => gradient;
        if (property === "canvas") return { width: 640, height: 360 };
        if (typeof property === "symbol") return undefined;
        return () => undefined;
      },
      set() {
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D;
}

function createWorld() {
  const hud = vi.fn<(snapshot: HudSnapshot) => void>();
  const cue = vi.fn<NonNullable<GameCallbacks["onAudioCue"]>>();
  const world = new GameWorld(createMockCtx(), { onHud: hud, onAudioCue: cue });
  return { world, hud, cue };
}

function player(world: GameWorld) {
  return (world as unknown as { player: { x: number; y: number; vx: number } }).player;
}

function internalTime(world: GameWorld) {
  return (world as unknown as { time: number }).time;
}

describe("GameWorld baseline states", () => {
  it("starts in menu and remains menu under ticks without input", () => {
    const { world } = createWorld();
    expect(world.getStatus()).toBe("menu");
    for (let i = 0; i < 30; i++) world.tick(1 / 60);
    expect(world.getStatus()).toBe("menu");
  });

  it("start() enters playing and emits a playing HUD snapshot", () => {
    const { world, hud } = createWorld();
    world.start();
    expect(world.getStatus()).toBe("playing");
    expect(hud.mock.calls.at(-1)?.[0].status).toBe("playing");
  });
});

describe("GameWorld pause / resume no time jump", () => {
  it("freezes position and in-game time across huge dt values while paused", () => {
    const { world } = createWorld();
    world.start();
    world.setInput({ right: true });
    for (let i = 0; i < 60; i++) world.tick(1 / 60);

    const xAtPause = player(world).x;
    const timeAtPause = internalTime(world);
    expect(xAtPause).toBeGreaterThan(80); // sanity: the run was moving

    world.press("pause");
    expect(world.getStatus()).toBe("paused");

    // Simulate rAF timestamps arriving after a very long background suspension.
    for (let i = 0; i < 10; i++) world.tick(60);

    expect(player(world).x).toBe(xAtPause);
    expect(player(world).vx).toBeDefined();
    expect(internalTime(world)).toBe(timeAtPause);

    world.press("pause");
    expect(world.getStatus()).toBe("playing");
    // A normal resume frame continues from the exact spot.
    world.tick(1 / 60);
    expect(player(world).x).toBeGreaterThanOrEqual(xAtPause);
    expect(player(world).x - xAtPause).toBeLessThan(4);
  });

  it("never teleports on an abusive large dt even without the gate", () => {
    const { world } = createWorld();
    world.start();
    world.setInput({ right: true });
    for (let i = 0; i < 30; i++) world.tick(1 / 60);
    const xBefore = player(world).x;
    world.tick(600); // direct caller passes ten minutes
    // World-level clamp turns this into at most ~2.2 physics frames (< 9px at max speed).
    expect(player(world).x - xBefore).toBeLessThan(9);
  });

  it("gate-integrated pause -> long gap -> resume produces zero catch-up displacement/time", () => {
    const { world } = createWorld();
    const gate = new RunGate();
    let now = 1000;
    // Mirror scene.ts's render loop exactly.
    const frame = () => {
      gate.setReason("pause", world.getStatus() === "paused");
      const dt = gate.sample(now);
      world.tick(dt);
    };

    world.start();
    frame(); // baseline frame yields dt 0
    world.setInput({ right: true });
    for (let i = 0; i < 30; i++) { now += 16.6667; frame(); }

    world.press("pause");
    now += 16.6667; frame(); // frame that observes the pause edge
    const xFrozen = player(world).x;
    const timeFrozen = internalTime(world);

    now += 600_000; frame(); // ten minutes elapse while paused
    expect(player(world).x).toBe(xFrozen);
    expect(internalTime(world)).toBe(timeFrozen);

    world.press("pause"); // resume
    now += 16.6667; frame(); // re-baseline frame: dt 0
    expect(player(world).x).toBe(xFrozen);
    now += 16.6667; frame(); // first real simulation frame
    expect(player(world).x - xFrozen).toBeLessThan(4);
    // Only ~30 short frames of time accumulated, never the ten-minute gap.
    expect(internalTime(world) - timeFrozen).toBeLessThan(0.1);
  });
});

describe("GameWorld external stops: blur / hidden / settings via gate", () => {
  it.each(["blurred", "hidden", "settings"])("stops and resumes cleanly for reason %s", (reason) => {
    const { world } = createWorld();
    const gate = new RunGate();
    let now = 0;
    const frame = (t: number) => { now = t; world.tick(gate.sample(now)); };

    world.start();
    frame(0);
    world.setInput({ right: true });
    for (let i = 1; i <= 30; i++) frame(i * 16.7);
    const xBeforeBlock = player(world).x;

    gate.setReason(reason, true);
    // Hundreds of frames with large timestamps while blocked must not move the player.
    for (let i = 0; i < 600; i++) frame(10_000 + i * 1000);
    expect(player(world).x).toBe(xBeforeBlock);
    expect(world.getStatus()).toBe("playing"); // external interruption does not rewrite status

    gate.setReason(reason, false);
    frame(700_000); // first frame after release re-baselines -> dt 0
    expect(player(world).x).toBe(xBeforeBlock);
    frame(700_016.7);
    expect(player(world).x - xBeforeBlock).toBeLessThan(4);
  });
});

describe("GameWorld.clearInput", () => {
  it("resets held directions, jump latch, and jump buffer", () => {
    const { world } = createWorld();
    world.setInput({ left: true, right: true, jump: true });
    world.clearInput();
    const internal = world as unknown as { input: Record<string, boolean>; wasJump: boolean; jumpBuffer: number };
    expect(internal.input).toEqual({ left: false, right: false, jump: false });
    expect(internal.wasJump).toBe(false);
    expect(internal.jumpBuffer).toBe(0);
  });
});
