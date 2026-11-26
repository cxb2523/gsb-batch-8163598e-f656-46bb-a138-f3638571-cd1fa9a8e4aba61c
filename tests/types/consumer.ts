import {
  CanvasBlueprint,
  CanvasSequence,
  CanvasSequenceError,
} from '../..';

const sequence = new CanvasSequence();
const blueprint = new CanvasBlueprint();

sequence.execute({} as CanvasRenderingContext2D);
blueprint.build({ value: 1 });

try {
  sequence.execute({} as CanvasRenderingContext2D);
} catch (error) {
  if (error instanceof CanvasSequenceError) {
    const index: number = error.index;
    const inst: string = error.inst;
    const type: 'method' | 'property' = error.type;
    const cause: Error = error.cause;
    const restoreError: Error | undefined = error.restoreError;
    void index;
    void inst;
    void type;
    void cause;
    void restoreError;
  }
}

const constructed = new CanvasSequenceError({
  index: 2,
  inst: 'arc',
  type: 'method',
  cause: new Error('boom'),
});
void constructed;
