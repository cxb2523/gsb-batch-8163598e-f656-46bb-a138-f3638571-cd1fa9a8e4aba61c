//A1 state-chain coverage: walk → jump → land → idle, hit interruption,
//illegal transitions, and walk-cycle restart after recovery.
//
//Same local-sample strategy as tests/walk-idle-transition.test.js: three and
//the sprite sheets are mocked, while the REAL character-state state machine
//and character-state-init descriptor helper are exercised so transition()
//validation and action cancellation are under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { State, transition, enterWalk, resumeWalk, cancelCharacterActions } from '@engine/actions/character-state';
import { createCharacterState } from '@engine/meshes/character-state-init';

vi.mock('three', () => {
  class MockGeometry {
    constructor(w, h) {
      this.parameters = { width: w || 1, height: h || 1 };
      this.dispose = vi.fn();
    }
  }
  class MockMaterial {
    constructor(opts) {
      Object.assign(this, opts || {});
      this.dispose = vi.fn();
    }
    clone() {
      const m = new MockMaterial();
      m.map = this.map;
      return m;
    }
  }
  class MockMesh {
    constructor(geo, mat) {
      this.geometry = geo || new MockGeometry();
      this.material = mat || new MockMaterial();
      this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.scale = { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.quaternion = { copy: vi.fn(), set: vi.fn() };
      this.renderOrder = 0;
      this.visible = true;
      this.frustumCulled = true;
      this.castShadow = false;
      this.receiveShadow = false;
      this.onBeforeRender = null;
      this.userData = {};
      this.parent = null;
    }
  }
  class MockGroup {
    constructor() {
      this.children = [];
      this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.quaternion = { copy: vi.fn() };
      this.frustumCulled = true;
      this.userData = {};
      this.updateMatrixWorld = vi.fn();
    }
    add(child) {
      this.children.push(child);
      child.parent = this;
    }
  }
  class MockQuaternion {
    copy() {
      return this;
    }
    invert() {
      return this;
    }
  }
  return {
    Group: MockGroup,
    Mesh: MockMesh,
    PlaneGeometry: MockGeometry,
    MeshBasicMaterial: MockMaterial,
    Quaternion: MockQuaternion,
    DoubleSide: 0,
    RepeatWrapping: 1000,
    ClampToEdgeWrapping: 1001,
    NearestFilter: 1003,
  };
});

const h = vi.hoisted(() => {
  //Faithful copy of resolveLoopingFrame's modulo resolution so the tests can
  //observe real cycle positions without importing the heavy character-utils.
  function resolveLoopingFrame(delays, cycleDuration, elapsedRaw) {
    const elapsed = ((elapsedRaw % cycleDuration) + cycleDuration) % cycleDuration;
    let t = 0;
    for (let i = 0; i < delays.length; i++) {
      t += delays[i];
      if (elapsed < t) return { frameIdx: i, elapsed };
    }
    return { frameIdx: delays.length - 1, elapsed };
  }
  return {
    applySpriteFrame: vi.fn(),
    playerJumpFrame: vi.fn(() => 0),
    playerLandFrame: vi.fn(() => -1),
    resolveLoopingFrame: vi.fn(resolveLoopingFrame),
    resolveVariableFrame: vi.fn(() => ({ frameIdx: 0, done: false })),
    positionOverlay: vi.fn(),
  };
});

const mockSpriteMap = {};
for (let i = 1; i <= 5; i++) {
  mockSpriteMap[`BF${i}`] = { x: 0, y: 0, w: 32, h: 40 };
  mockSpriteMap[`BB${i}`] = { x: 0, y: 0, w: 32, h: 40 };
  mockSpriteMap[`RF${i}`] = { x: 0, y: 0, w: 16, h: 24 };
  mockSpriteMap[`LF${i}`] = { x: 0, y: 0, w: 16, h: 24 };
  mockSpriteMap[`RB${i}`] = { x: 0, y: 0, w: 16, h: 24 };
  mockSpriteMap[`LB${i}`] = { x: 0, y: 0, w: 16, h: 24 };
  mockSpriteMap[`P${i}`] = { x: 0, y: 0, w: 32, h: 40 };
}
for (const id of ['EF1', 'EF2', 'EFR3', 'EFR4', 'EFR5', 'EFL3', 'EFL4', 'EFL5']) {
  mockSpriteMap[id] = { x: 0, y: 0, w: 16, h: 24 };
}
for (let i = 1; i <= 4; i++) {
  mockSpriteMap[`AF${i}`] = { x: 0, y: 0, w: 24, h: 24 };
  mockSpriteMap[`AB${i}`] = { x: 0, y: 0, w: 24, h: 24 };
}
for (const id of ['LG3', 'LG6', 'LG11', 'LG12', 'LG14', 'LG16', 'LG27', 'LG30', 'LG42', 'LG43', 'LG44', 'LG47', 'LG56', 'TF1', 'TF2', 'TB1', 'TB2']) {
  mockSpriteMap[id] = { x: 0, y: 0, w: 24, h: 24 };
}
for (let i = 1; i <= 4; i++) mockSpriteMap[`CH${i}`] = { x: 0, y: 0, w: 32, h: 32 };
mockSpriteMap['SR17'] = { x: 0, y: 0, w: 32, h: 16 };
mockSpriteMap['SR18'] = { x: 0, y: 0, w: 32, h: 16 };

vi.mock('@engine/constants/sprites', () => ({
  SPRITE_MAP: mockSpriteMap,
  SHEET_W: 256,
  SHEET_H: 488,
}));

function makePattern(bodyPrefix, handBehind, handFront, reversed) {
  const body = [];
  const hands = [];
  for (let i = 1; i <= 5; i++) {
    body.push({ id: `${bodyPrefix}${i}`, reversed, anchor: { dx: 0, dy: [2, 1, 0, 1, 2][i - 1] } });
    hands.push([
      { id: `${handBehind}${i}`, dx: -8, dy: 0 },
      { id: `${handFront}${i}`, dx: 8, dy: 0 },
    ]);
  }
  return { body, hands, reversed, sequenceManuallyReversed: false };
}

function makeJumpPattern(bodyPrefix, behindId, frontId, reversed) {
  const frames = [];
  for (let i = 0; i < 9; i++) {
    frames.push({
      body: `${bodyPrefix}${i < 5 ? 4 : 3}`,
      behind: { id: behindId, dx: -4, dy: 0 },
      front: { id: frontId, dx: 4, dy: 4 },
      anchor: { dx: 0, dy: 0 },
    });
  }
  return { frames, reversed };
}

function makeStabPattern(bodyPrefix, overlayFarBehind, overlayHead, overlayFront, reversed) {
  const frames = [];
  for (let i = 0; i < 9; i++) {
    frames.push({
      body: `${bodyPrefix}${(i % 4) + 1}`,
      farBehind: { id: overlayFarBehind, dx: -4, dy: 0 },
      head: { id: overlayHead, dx: 0, dy: -8 },
      front: { id: overlayFront, dx: 4, dy: 0 },
      anchor: { dx: 1, dy: 4 },
    });
  }
  return { frames, reversed };
}

function makeCastPattern(body1, body2, overlay, reversed) {
  return {
    frames: [
      { body: body1, overlay, overlayDx: 0, overlayDy: 16, reversed, anchor: { dx: 0, dy: -4 } },
      { body: body2, overlay, overlayDx: 0, overlayDy: 16, reversed, anchor: { dx: 0, dy: -4 } },
    ],
    reversed,
  };
}

vi.mock('@engine/actions/action-timelines', () => ({
  CAST_FRAME_S: 1 / 3,
  playerJumpFrame: h.playerJumpFrame,
  playerLandFrame: h.playerLandFrame,
}));

vi.mock('@engine/constants/sprites/assembly', () => ({
  STAB_LV3_DELAYS: [4, 8, 2, 2, 2, 14, 2, 2, 4].map((t) => t * 1000 / 60),
  WALK_ASSEMBLY: [
    makePattern('BF', 'RF', 'LF', true),
    makePattern('BF', 'RF', 'LF', false),
    makePattern('BB', 'LB', 'RB', false),
    makePattern('BB', 'LB', 'RB', true),
  ],
  JUMP_ASSEMBLY: [
    makeJumpPattern('BF', 'RF4', 'LF3', true),
    makeJumpPattern('BF', 'RF4', 'LF3', false),
    makeJumpPattern('BB', 'RB1', 'LB4', false),
    makeJumpPattern('BB', 'RB1', 'LB4', true),
  ],
  STAB_LV3_ASSEMBLY: [
    makeStabPattern('AF', 'LG16', 'TF1', 'LG12', true),
    makeStabPattern('AF', 'LG16', 'TF1', 'LG12', false),
    makeStabPattern('AB', 'LG56', 'TB1', 'LG42', false),
    makeStabPattern('AB', 'LG56', 'TB1', 'LG42', true),
  ],
  CAST_ASSEMBLY: [
    makeCastPattern('CH1', 'CH2', 'SR17', true),
    makeCastPattern('CH1', 'CH2', 'SR17', false),
    makeCastPattern('CH3', 'CH4', 'SR18', false),
    makeCastPattern('CH3', 'CH4', 'SR18', true),
  ],
}));

vi.mock('@engine/meshes/character-utils', () => ({
  BODY_W: 32,
  ASSEMBLY_STEP_MAP: [0, 1, 1, 2, 2, 3, 3, 0],
  FAR_BEHIND: -2,
  BEHIND: -1,
  IN_FRONT: 2,
  STANDARD_CONTAINER_H: 40,
  resolveLoopingFrame: h.resolveLoopingFrame,
  resolveVariableFrame: h.resolveVariableFrame,
  azimuthToStep: vi.fn(() => 1),
  applySpriteFrame: h.applySpriteFrame,
  cloneSpriteTexture: vi.fn(() => ({ offset: { x: 0, y: 0 }, repeat: { x: 1, y: 1 }, needsUpdate: false })),
  createBillboardOverlay: vi.fn(() => ({
    mesh: {
      position: { x: 0, y: 0, z: 0, set: vi.fn() },
      scale: { x: 1, y: 1, z: 1 },
      renderOrder: 0,
      visible: true,
      frustumCulled: false,
      castShadow: false,
      receiveShadow: false,
      material: { map: { offset: { x: 0, y: 0 }, repeat: { x: 1, y: 1 } } },
    },
    texture: { offset: { x: 0, y: 0 }, repeat: { x: 1, y: 1 } },
  })),
  FACE: 3,
  anchorBodyX: vi.fn(() => 0),
  anchorBodyY: vi.fn(() => 0),
  positionOverlay: h.positionOverlay,
  isCharacterOnScreen: vi.fn(() => true),
  //Production placeIdleBody writes scale.y = 1; mirror that side effect.
  placeIdleBody: vi.fn((mesh) => {
    mesh.scale.y = 1;
  }),
  seqMoveLocal: vi.fn(() => ({ x: 0, y: 0 })),
  setVisualDriver: vi.fn((root, driver, update) => {
    driver.onBeforeRender = update;
  }),
}));

vi.mock('@engine/meshes/createCharacter', () => ({
  IDLE_FRAMES: [
    { id: 'P3', reversed: false },
    { id: 'P2', reversed: false },
    { id: 'P1', reversed: false },
    { id: 'P4', reversed: false },
    { id: 'P5', reversed: false },
    { id: 'P4', reversed: true },
    { id: 'P1', reversed: true },
    { id: 'P2', reversed: true },
  ],
}));

function makeCamera(now) {
  return {
    quaternion: { copy: vi.fn() },
    position: { x: 0.5, z: -0.5 },
    userData: { isMainCamera: true, frustum: null, now },
  };
}

async function buildA1Group(now = 0) {
  const THREE = await import('three');
  const geo = new THREE.PlaneGeometry(24, 30);
  const bodyMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  bodyMesh.material.map = { offset: { x: 0, y: 0 }, repeat: { x: 1, y: 1 } };

  const textures = {
    skins: {
      characterSpriteSheet: {
        clone: () => ({ offset: { x: 0, y: 0 }, repeat: { x: 1, y: 1 }, needsUpdate: false }),
      },
    },
  };

  const { createWalkGroup } = await import('@engine/meshes/character-groups/group-walk');
  const group = createWalkGroup({
    node: { x: 0, y: 0, z: 0 },
    textures,
    direction: 'SE',
    directionOffset: 1,
    walkStart: now,
    worldX: 0,
    worldY: 0,
    worldZ: 0,
    bodyMesh,
    mode: 'A1',
  });

  //Mirror the exclusive overlay handles the A1 registry wrapper attaches.
  const ch = group.userData.character;
  ch._stabHeadMesh = { visible: false, renderOrder: 1, position: { set: vi.fn() }, scale: { x: 1, y: 1 } };
  ch._castOverlayMesh = { visible: false, renderOrder: -1, position: { set: vi.fn() }, scale: { x: 1, y: 1 } };

  const body = group.children[0];
  const render = (camera) => body.onBeforeRender.call(body, {}, {}, camera);
  return { group, body, ch, render };
}

//Last sprite id applied to the BODY plane's material map.
function lastBodySpriteId(bodyMaterialMap) {
  const calls = h.applySpriteFrame.mock.calls.filter((c) => c[0] === bodyMaterialMap);
  return calls.length ? calls[calls.length - 1][1] : null;
}

describe('A1 state chain — transition() invariants (pure descriptor)', () => {
  beforeEach(() => {
    h.applySpriteFrame.mockClear();
  });

  function bareCh(overrides = {}) {
    return createCharacterState({
      mode: 'A1',
      directionOffset: 1,
      walkStart: 1000,
      billboardHeight: 30,
      extras: { state: State.IDLE, ...overrides },
    });
  }

  it('entering KNOCKBACK clears jump/stab/cast handles and hides exclusive overlays', () => {
    const stabHead = { visible: true };
    const castLegs = { visible: true };
    const ch = bareCh({
      walkStopped: false,
      _jumpAction: { startTime: 1 },
      _attackAction: { startTime: 2 },
      _castAction: { startTime: 3 },
      _stabHeadMesh: stabHead,
      _castOverlayMesh: castLegs,
    });

    const ok = transition(ch, State.KNOCKBACK, 5000);

    expect(ok).toBe(true);
    expect(ch.state).toBe(State.KNOCKBACK);
    expect(ch.action).toBeNull();
    expect(ch._jumpAction).toBeNull();
    expect(ch._attackAction).toBeNull();
    expect(ch._castAction).toBeNull();
    expect(ch._landedAt).toBeUndefined();
    expect(stabHead.visible).toBe(false);
    expect(castLegs.visible).toBe(false);
  });

  it.each([
    ['KNEELING', State.IDLE],
    ['CRITICALLY_HURT', State.KNOCKBACK],
    ['DEAD', State.IDLE],
  ])('entering priority state %s cancels actions', (name, origin) => {
    const ch = bareCh({ state: origin, _jumpAction: { startTime: 1 } });
    expect(transition(ch, State[name])).toBe(true);
    expect(ch.state).toBe(State[name]);
    expect(ch._jumpAction).toBeNull();
  });

  it('rejects DEAD → IDLE and mutates nothing (state, walkStart, visibility preserved)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stabHead = { visible: false };
    const castLegs = { visible: false };
    const ch = bareCh({
      state: State.DEAD,
      walkStart: 42,
      _stabHeadMesh: stabHead,
      _castOverlayMesh: castLegs,
    });

    const ok = transition(ch, State.IDLE, 9999);

    expect(ok).toBe(false);
    expect(ch.state).toBe(State.DEAD);
    expect(ch.walkStart).toBe(42);
    expect(stabHead.visible).toBe(false);
    expect(castLegs.visible).toBe(false);
    warn.mockRestore();
  });

  it('rebases walkStart when recovery enters IDLE with an entry timestamp', () => {
    const ch = bareCh({ state: State.KNOCKBACK, walkStart: 0 });
    expect(transition(ch, State.FALLING)).toBe(true);
    expect(transition(ch, State.IDLE, 7777)).toBe(true);
    expect(ch.state).toBe(State.IDLE);
    expect(ch.walkStart).toBe(7777);
  });

  it('enterWalk/resumeWalk rebase walkStart and invalidate frame caches', () => {
    const ch = bareCh({ walkStart: 123, lastStep: 3, lastFrame: 5, lastPose: 'priority' });
    const returned = enterWalk(ch, 4096);
    expect(returned).toBe(ch);
    expect(ch.walkStopped).toBe(false);
    expect(ch.walkStart).toBe(4096);
    expect(ch.lastStep).toBe(-1);
    expect(ch.lastFrame).toBe(-1);
    expect(ch.lastPose).toBeNull();
    //The recovery alias is the same invariant.
    expect(resumeWalk).toBe(enterWalk);
    resumeWalk(ch, 5000);
    expect(ch.walkStart).toBe(5000);
  });

  it('cancelCharacterActions tolerates a bare descriptor and nulls handles', () => {
    expect(cancelCharacterActions(null)).toBe(false);
    const ch = { action: 'JUMP', _jumpAction: {}, _attackAction: {}, _castAction: {}, _landedAt: 7 };
    expect(cancelCharacterActions(ch)).toBe(true);
    expect(ch.action).toBeNull();
    expect(ch._jumpAction).toBeNull();
    expect(ch._attackAction).toBeNull();
    expect(ch._castAction).toBeNull();
    expect(ch._landedAt).toBeUndefined();
  });
});

describe('A1 state chain — rendered group', () => {
  beforeEach(() => {
    h.applySpriteFrame.mockClear();
    h.playerJumpFrame.mockReset();
    h.playerLandFrame.mockReset();
    h.resolveLoopingFrame.mockClear();
    h.positionOverlay.mockClear();
    h.playerJumpFrame.mockReturnValue(0);
    h.playerLandFrame.mockReturnValue(-1);
  });

  it('walk → jump → landing frames → idle: visibility, frames and scale follow the state', async () => {
    const t0 = 1000;
    const { group, body, ch, render } = await buildA1Group(t0);
    const camera = makeCamera(t0);
    const maps = body.material.map;

    // --- WALK: both hands visible, walk body tile ---
    ch.state = State.IDLE;
    ch.walkStopped = false;
    render(camera);
    expect(group.children[1].visible).toBe(true);
    expect(group.children[2].visible).toBe(true);
    expect(lastBodySpriteId(maps)).toBe('BF3'); // cycle frame 0 → SEQ base index 2
    expect(ch.lastPose).toBe('walk');

    // --- JUMP: hands stay visible, jump body tile + jump timing ---
    h.applySpriteFrame.mockClear();
    ch._jumpAction = { phase: 'rise', startTime: t0 };
    camera.userData.now = t0 + 120;
    render(camera);
    expect(h.playerJumpFrame).toHaveBeenCalledTimes(1);
    expect(group.children[1].visible).toBe(true);
    expect(group.children[2].visible).toBe(true);
    expect(lastBodySpriteId(maps)).toMatch(/^(BF|BB)[34]$/);
    expect(ch.lastPose).toBe('jump');
    //Exclusive overlays must not leak into the jump.
    expect(ch._stabHeadMesh.visible).toBe(false);
    expect(ch._castOverlayMesh.visible).toBe(false);

    // --- LAND: existing landing frame index drives the composite ---
    h.playerLandFrame.mockReturnValue(2);
    ch._jumpAction = null;
    ch._landedAt = t0 + 500;
    ch.walkStopped = true;
    ch.state = State.IDLE;
    camera.userData.now = t0 + 620;
    render(camera);
    expect(h.playerLandFrame).toHaveBeenCalledTimes(1);
    expect(ch.lastPose).toBe('land');
    expect(ch.lastFrame).toBe(2);
    expect(group.children[1].visible).toBe(true);
    expect(group.children[2].visible).toBe(true);

    // --- LANDING FINISHED: whole idle sprite, hands hidden, scale restored ---
    h.playerLandFrame.mockReturnValue(-1);
    camera.userData.now = t0 + 1500;
    render(camera);
    expect(ch.lastPose).toBe('idle');
    expect(ch.lastFrame).toBe(-1);
    expect(group.children[1].visible).toBe(false);
    expect(group.children[2].visible).toBe(false);
    expect(lastBodySpriteId(maps)).toMatch(/^P[1-5]$/);
    expect(body.scale.y).toBe(1);
  });

  it('KNOCKBACK interrupting a jump clears action fields and hides every overlay', async () => {
    const t0 = 4000;
    const { group, ch, render } = await buildA1Group(t0);
    const camera = makeCamera(t0);
    ch.state = State.IDLE;
    ch.walkStopped = false;
    render(camera);

    //Jump is live and an exclusive overlay is visibly lingering.
    ch._jumpAction = { startTime: t0 };
    ch._stabHeadMesh.visible = true;
    ch._castOverlayMesh.visible = true;
    camera.userData.now = t0 + 100;
    render(camera);
    expect(ch.lastPose).toBe('jump');

    //The validated KNOCKBACK transition is the single state-switch gate.
    const ok = transition(ch, State.KNOCKBACK);
    expect(ok).toBe(true);
    expect(ch._jumpAction).toBeNull();
    expect(ch._attackAction).toBeNull();
    expect(ch._castAction).toBeNull();
    expect(ch._stabHeadMesh.visible).toBe(false);
    expect(ch._castOverlayMesh.visible).toBe(false);

    //A render keeps the same consistent picture: no hands, no overlays.
    render(camera);
    expect(ch.lastPose).toBe('priority');
    expect(group.children[1].visible).toBe(false);
    expect(group.children[2].visible).toBe(false);
    expect(ch._stabHeadMesh.visible).toBe(false);
    expect(ch._castOverlayMesh.visible).toBe(false);
  });

  it('registered A1 factory wires the real overlay meshes that transition() hides', async () => {
    const THREE = await import('three');
    await import('@engine/meshes/character-groups/group-walk');
    const { getCharacterModeFactory } = await import('@engine/common/registry');
    const geo = new THREE.PlaneGeometry(24, 30);
    const bodyMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
    bodyMesh.material.map = { offset: { x: 0, y: 0 }, repeat: { x: 1, y: 1 } };
    const textures = {
      skins: { characterSpriteSheet: { clone: () => ({ offset: { x: 0, y: 0 }, repeat: { x: 1, y: 1 } }) } },
    };

    const factory = getCharacterModeFactory('A1');
    expect(typeof factory).toBe('function');
    const group = factory({
      node: { x: 0, y: 0, z: 0 },
      textures,
      direction: 'SE',
      directionOffset: 1,
      walkStart: 100,
      now: 100,
      worldX: 0,
      worldY: 0,
      worldZ: 0,
      bodyMesh,
    });
    const ch = group.userData.character;
    expect(ch._stabHeadMesh).toBeTruthy();
    expect(ch._castOverlayMesh).toBeTruthy();
    expect(ch._stabHeadMesh.visible).toBe(false);
    expect(ch._castOverlayMesh.visible).toBe(false);

    //Arm both exclusive overlays like a stab/cast would leave them.
    ch._jumpAction = { startTime: 100 };
    ch._stabHeadMesh.visible = true;
    ch._castOverlayMesh.visible = true;

    expect(transition(ch, State.KNOCKBACK)).toBe(true);
    //transition() hides the ACTUAL registered mesh references synchronously.
    expect(ch._jumpAction).toBeNull();
    expect(ch._stabHeadMesh.visible).toBe(false);
    expect(ch._castOverlayMesh.visible).toBe(false);
  });

  it('hit during cast restores body scale to 1 and hides the cast legs strip', async () => {
    const t0 = 9000;
    const { body, ch, render } = await buildA1Group(t0);
    const camera = makeCamera(t0);

    ch.state = State.IDLE;
    ch.walkStopped = true;
    ch._castAction = { startTime: t0 };
    camera.userData.now = t0 + 100;
    render(camera);
    expect(ch.lastPose).toBe('cast');
    expect(body.scale.y).toBeCloseTo(32 / 40); // CH bodies are 32px tall
    expect(ch._castOverlayMesh.visible).toBe(true);

    transition(ch, State.KNOCKBACK);
    render(camera);

    expect(ch._castAction).toBeNull();
    expect(ch._castOverlayMesh.visible).toBe(false);
    expect(body.scale.y).toBe(1);
  });

  it('direct priority-state assignment is normalized on the next render even without transition()', async () => {
    const t0 = 2000;
    const { group, ch, render } = await buildA1Group(t0);
    const camera = makeCamera(t0);
    ch.state = State.IDLE;
    ch.walkStopped = false;
    render(camera);

    ch._jumpAction = { startTime: t0 };
    ch._stabHeadMesh.visible = true;
    //Bypass transition() on purpose — the driver must still converge.
    ch.state = State.DEAD;
    render(camera);

    expect(ch._jumpAction).toBeNull();
    expect(ch._attackAction).toBeNull();
    expect(ch._castAction).toBeNull();
    expect(ch._stabHeadMesh.visible).toBe(false);
    expect(ch._castOverlayMesh.visible).toBe(false);
    expect(group.children[1].visible).toBe(false);
    expect(group.children[2].visible).toBe(false);
  });

  it('illegal DEAD → IDLE transition leaves the rendered output unchanged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t0 = 3000;
    const { group, body, ch, render } = await buildA1Group(t0);
    const camera = makeCamera(t0);
    ch.state = State.IDLE;
    ch.walkStopped = true;

    expect(transition(ch, State.DEAD)).toBe(true);
    render(camera); // baseline DEAD/priority render

    const visibilityBefore = [
      group.children[1].visible,
      group.children[2].visible,
      ch._stabHeadMesh.visible,
      ch._castOverlayMesh.visible,
    ];
    h.applySpriteFrame.mockClear();

    const ok = transition(ch, State.IDLE);
    expect(ok).toBe(false);
    expect(ch.state).toBe(State.DEAD);
    expect([
      group.children[1].visible,
      group.children[2].visible,
      ch._stabHeadMesh.visible,
      ch._castOverlayMesh.visible,
    ]).toEqual(visibilityBefore);

    render(camera);
    //Same state + same step → no sprite re-application and visibility stable.
    expect(h.applySpriteFrame).not.toHaveBeenCalled();
    expect(ch.state).toBe(State.DEAD);
    warn.mockRestore();
  });

  it('resumes walk from a hit at cycle frame 0 with walkStart rebased to entry time', async () => {
    const t0 = 0;
    const { body, ch, render } = await buildA1Group(t0);
    const camera = makeCamera(t0);
    const maps = body.material.map;

    //Enter walk at t=0 and advance 0.5s into the cycle → nonzero frame.
    ch.state = State.IDLE;
    ch.walkStopped = false;
    camera.userData.now = 0;
    render(camera);
    camera.userData.now = 500;
    render(camera);
    const staleCalls = h.resolveLoopingFrame.mock.calls;
    const staleElapsed = staleCalls[staleCalls.length - 1][2];
    expect(staleElapsed).toBeCloseTo(0.5, 5);
    expect(lastBodySpriteId(maps)).toBe('BF2'); // frameIdx 3 → base index 1

    //Hit during the walk.
    expect(transition(ch, State.KNOCKBACK)).toBe(true);
    camera.userData.now = 600;
    render(camera);
    expect(ch.lastPose).toBe('priority');

    //Legal recovery chain KNOCKBACK → FALLING → IDLE, then walk again at T.
    const resumeAt = 2000;
    expect(transition(ch, State.FALLING)).toBe(true);
    expect(transition(ch, State.IDLE)).toBe(true);
    ch.walkStopped = false;
    camera.userData.now = resumeAt;
    h.applySpriteFrame.mockClear();
    render(camera);

    expect(ch.walkStart).toBe(resumeAt);
    const resumeCalls = h.resolveLoopingFrame.mock.calls;
    const resumeElapsedRaw = resumeCalls[resumeCalls.length - 1][2];
    expect(resumeElapsedRaw).toBe(0);
    //Cycle-start frame (frameIdx 0 → SEQ base index 2), not the stale BF2.
    expect(lastBodySpriteId(maps)).toBe('BF3');
    expect(ch.lastFrame).toBe(0);
  });

  it('resumes walk from an interrupted jump at cycle frame 0', async () => {
    const { body, ch, render } = await buildA1Group(0);
    const camera = makeCamera(0);
    const maps = body.material.map;

    ch.state = State.IDLE;
    ch.walkStopped = false;
    camera.userData.now = 0;
    render(camera);

    ch._jumpAction = { startTime: 0 };
    camera.userData.now = 120;
    render(camera);
    expect(ch.lastPose).toBe('jump');

    //Player steers immediately on landing: jump cleared, walk resumes without
    //playing the landing stall.
    ch._jumpAction = null;
    ch._landedAt = undefined;
    ch.walkStopped = false;
    camera.userData.now = 800;
    render(camera);

    expect(ch.lastPose).toBe('walk');
    expect(ch.walkStart).toBe(800);
    const elapsedRaw = h.resolveLoopingFrame.mock.calls.at(-1)[2];
    expect(elapsedRaw).toBe(0);
    expect(lastBodySpriteId(maps)).toBe('BF3');
  });
});
