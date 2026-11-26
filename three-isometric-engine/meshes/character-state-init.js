//NOTE(jimmylee)
//Single-point-of-entry for character descriptor construction. Every
//character-group factory routes through this helper so the descriptor
//contract — `lastStep`/`lastFrame` sentinels, the default `state`, and the
//`action: null` field — is owned by one file. When a new universal field is added to the descriptor it lands in
//every mode in a single edit. Mode-specific fields go through `extras`.

import { State } from '@engine/actions/character-state';

export function createCharacterState({
  mode,
  directionOffset,
  walkStart,
  billboardHeight,
  state,
  extras,
}) {
  const ch = {
    directionOffset,
    mode,
    walkStart,
    billboardHeight,
    lastStep: -1,
    lastFrame: -1,
    state: state ?? State.FALLING,
    action: null,
    //NOTE(jimmylee)
    //Transient A1 action handles. `transition()` cancels these when a
    //priority state is entered and the walk/jump drivers key frames off
    //them. Locked to null/undefined here so no descriptor starts with a
    //stale action a state switch would have to chase down.
    _jumpAction: null,
    _attackAction: null,
    _castAction: null,
    _landedAt: undefined,
    //NOTE(jimmylee)
    //Which render branch last drew the character ('walk', 'idle', 'jump',
    //'land', 'stab', 'cast', 'priority'). The walk driver uses transitions
    //into/out of 'walk' to rebase `walkStart` at the actual walk-entry time
    //instead of resuming a stale cycle phase after a jump or hit.
    lastPose: null,
  };
  if (extras) Object.assign(ch, extras);
  return ch;
}
