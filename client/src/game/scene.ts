// Signal Meadow style: Babylon is the picture frame; the authored stepped game image is painted inside one crisp logical surface.
import { Engine } from "@babylonjs/core/Engines/engine";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Scene } from "@babylonjs/core/scene";
import type { GameCallbacks, InputState } from "./types";
import { GameWorld } from "./GameWorld";
import { RunGate, BLOCK_REASONS } from "./runGate";

export type GameHandle = {
  scene: Scene;
  world: GameWorld;
  gate: RunGate;
  setInput: (input: Partial<InputState>) => void;
  press: (action: "pause" | "restart") => void;
  start: () => void;
  /** Block/unblock one named interruption reason (settings/hidden/blurred; pause is reconciled from world status). */
  setBlocked: (reason: string, blocked: boolean) => void;
  clearInput: () => void;
  dispose: () => void;
};

export function createGameScene(engine: Engine, _canvas: HTMLCanvasElement, callbacks: GameCallbacks): GameHandle {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.08, 0.1, 1);
  const camera = new FreeCamera("bytebound-camera", new Vector3(0, 0, -10), scene);
  camera.setTarget(Vector3.Zero()); camera.mode = 1; camera.orthoLeft = -8; camera.orthoRight = 8; camera.orthoTop = 4.5; camera.orthoBottom = -4.5; camera.minZ = 0.1; camera.maxZ = 100;
  const texture = new DynamicTexture("bytebound-screen", { width: 640, height: 360 }, scene, false);
  texture.hasAlpha = false; texture.wrapU = Texture.CLAMP_ADDRESSMODE; texture.wrapV = Texture.CLAMP_ADDRESSMODE; texture.vScale = -1; texture.vOffset = 1; texture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  const plane = MeshBuilder.CreatePlane("bytebound-plane", { width: 16, height: 9 }, scene);
  const material = new StandardMaterial("bytebound-screen-material", scene);
  material.diffuseTexture = texture; material.emissiveTexture = texture; material.emissiveColor = Color3.White(); material.disableLighting = true; plane.material = material;
  const world = new GameWorld(texture.getContext() as unknown as CanvasRenderingContext2D, callbacks);
  // Single advancement authority shared by the frame loop, GameCanvas DOM events, and audio.
  const gate = new RunGate();
  let active = true;
  engine.runRenderLoop(() => {
    if (!active) return;
    // Reconcile the manual-pause reason from authoritative world status every frame so
    // restart-while-paused and other status transitions can never leave a stale block.
    gate.setReason(BLOCK_REASONS.pause, world.getStatus() === "paused");
    // The gate owns the time baseline: blocked/suspended frames yield 0 and resume re-baselines.
    const dt = gate.sample(performance.now());
    world.tick(dt);
    texture.update(false);
    scene.render();
  });
  return {
    scene,
    world,
    gate,
    setInput: (input) => world.setInput(input),
    press: (action) => world.press(action),
    start: () => world.start(),
    setBlocked: (reason, blocked) => gate.setReason(reason, blocked),
    clearInput: () => world.clearInput(),
    dispose: () => { active = false; plane.dispose(); material.dispose(); texture.dispose(); scene.dispose(); },
  };
}
