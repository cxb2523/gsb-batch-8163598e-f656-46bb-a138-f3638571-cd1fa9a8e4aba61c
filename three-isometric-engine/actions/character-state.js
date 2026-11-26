//NOTE(jimmylee)
//Character state machine — pure data and validation. Zero rendering or physics imports.
//Two enums: State (lifecycle) and ActionType (behavior identity).
//transition() validates against the transition graph; entering a Priority
//State cancels every running action (see cancelCharacterActions).

export const State = {
  SPAWNING: 'SPAWNING',
  FALLING: 'FALLING',
  IDLE: 'IDLE',
  KNOCKBACK: 'KNOCKBACK',
  KNEELING: 'KNEELING',
  CRITICALLY_HURT: 'CRITICALLY_HURT',
  DEAD: 'DEAD',
};

export const ActionType = {
  CATCH: 'CATCH',
  JUMP: 'JUMP',
  THROW: 'THROW',
  PUNCH: 'PUNCH',
  QUICK_THROW: 'QUICK_THROW',
  CAST: 'CAST',
};

export const VALID_TRANSITIONS = {
  [State.SPAWNING]: [State.FALLING],
  [State.FALLING]: [State.SPAWNING, State.IDLE, State.KNOCKBACK, State.KNEELING, State.DEAD],
  [State.IDLE]: [State.FALLING, State.KNOCKBACK, State.KNEELING, State.DEAD],
  [State.KNOCKBACK]: [State.FALLING, State.CRITICALLY_HURT, State.DEAD],
  [State.KNEELING]: [State.IDLE, State.CRITICALLY_HURT, State.KNOCKBACK, State.DEAD],
  [State.CRITICALLY_HURT]: [State.KNOCKBACK, State.DEAD],
  [State.DEAD]: [],
};

//NOTE(jimmylee)
//States that preempt every running action (hit flinch, kneel, critical
//injury, death). Entering one cancels jump/cast/stab immediately so their
//overlays cannot survive the state switch.
export const PRIORITY_STATES = new Set([State.KNOCKBACK, State.KNEELING, State.CRITICALLY_HURT, State.DEAD]);

//NOTE(jimmylee)
//Transient action handles the A1 composite hangs off the descriptor. Kept
//as a list so cancellation can never miss one when a new action is added.
const TRANSIENT_ACTION_FIELDS = ['_jumpAction', '_attackAction', '_castAction'];

export function canTransition(ch, target) {
  return VALID_TRANSITIONS[ch.state]?.includes(target) ?? false;
}

//NOTE(jimmylee)
//Clears every running action off `ch` and immediately hides the exclusive
//overlay meshes a cancelled action may have left visible (the stab head
//tile and the cast legs strip). Safe to call with a bare descriptor: mesh
//handles are optional. Does not touch `state` or validate anything — callers
//that change state go through transition().
export function cancelCharacterActions(ch) {
  if (!ch) return false;
  ch.action = null;
  for (const field of TRANSIENT_ACTION_FIELDS) ch[field] = null;
  ch._landedAt = undefined;
  if (ch._stabHeadMesh) ch._stabHeadMesh.visible = false;
  if (ch._castOverlayMesh) ch._castOverlayMesh.visible = false;
  return true;
}

//NOTE(jimmylee)
//Canonical entry into the walk cycle. `walkStart` is the walk clock base,
//so it is rebased to the entry timestamp: resuming walking after a jump,
//landing or hit must play frame 0 of the cycle rather than the stale phase
//of the old walkStart. Invalidates the frame cache and pose marker so the
//next render reapplies walk sprites even when indices coincide. `now` may
//be omitted by callers that rebase on the next render pass themselves.
export function enterWalk(ch, now) {
  if (!ch) return ch;
  ch.walkStopped = false;
  if (now !== undefined && now !== null && Number.isFinite(now)) ch.walkStart = now;
  ch.lastStep = -1;
  ch.lastFrame = -1;
  ch.lastPose = null;
  return ch;
}

//Descriptive aliases for the same walk-entry invariant — input code reaches
//for whichever verb matches its call site.
export const resumeWalk = enterWalk;
export const startWalk = enterWalk;
export const clearActions = cancelCharacterActions;
export const cancelActions = cancelCharacterActions;

export function transition(ch, target, now) {
  if (!canTransition(ch, target)) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[character-state] Invalid transition: ${ch.state} → ${target}`);
    }
    return false;
  }
  ch.state = target;
  if (PRIORITY_STATES.has(target)) {
    //NOTE(jimmylee)
    //A priority state wins over jump/cast/stab at once. Clearing the action
    //handles keeps the render driver out of those branches, hiding the
    //exclusive overlays; resetting the sentinels forces the new state's
    //frame to apply on the next render.
    cancelCharacterActions(ch);
    ch.lastStep = -1;
    ch.lastFrame = -1;
    ch.lastPose = null;
  } else if (now !== undefined && now !== null && Number.isFinite(now) && target === State.IDLE) {
    //NOTE(jimmylee)
    //Settling/recovering into IDLE with an entry timestamp rebases the
    //loop clocks exactly as settleOnGround() does manually. Walking is
    //IDLE + walkStopped === false, so recovery callers then flip
    //walkStopped and the cycle starts here.
    ch.walkStart = now;
    ch.lastStep = -1;
    ch.lastFrame = -1;
    ch.lastPose = null;
  }
  return true;
}
