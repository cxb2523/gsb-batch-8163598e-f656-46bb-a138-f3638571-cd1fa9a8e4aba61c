import {vi} from 'vitest';
import {mockData} from '@earwurm/mocks';

import type {Earwurm} from '../Earwurm';
import type {LibraryEntry, StackId} from '../types';

export const mockEntries: LibraryEntry[] = [
  {id: 'Zero', path: mockData.audio},
  {id: 'One', path: 'to/no/file.mp3'},
  {id: 'Two', path: ''},
];

export const mockInitialKeys: StackId[] = mockEntries.map(({id}) => id);

export function managerSetup(
  earwurmInstance: Earwurm,
  library: LibraryEntry[],
) {
  earwurmInstance.add(...library);
  earwurmInstance.unlock();

  const clickEvent = new Event('click');
  document.dispatchEvent(clickEvent);
}

///
/// Deferred `fetch` helpers
///
/// These let us keep a `prepare()` suspended at the network-loading
/// step so we can exercise `stop()`/`teardown()`/replacement *while*
/// the load is in flight, then flush the load deterministically.

export interface DeferredFetchControl {
  // Resolves the next pending request with a successful response.
  resolve: () => void;
  // Rejects the next pending request, exercising the scratch fallback.
  reject: (error?: Error) => void;
}

function mockAudioResponse(): Response {
  // `fetchAudioBuffer` only needs `.ok` and `.arrayBuffer()`.
  // The mocked `AudioContext.decodeAudioData()` ignores the payload.
  return {
    ok: true,
    arrayBuffer: async () => {
      return new ArrayBuffer(0);
    },
  } as Response;
}

/**
 * Stubs `globalThis.fetch` so each request returns a manually
 * controllable Promise. Controls are handed back in request order.
 *
 * Pair with `await vi.waitFor(() => expect(controls).toHaveLength(n))`
 * to know exactly when each load has reached the network step.
 */
export function stubDeferredFetch() {
  const controls: DeferredFetchControl[] = [];

  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    const control: Partial<DeferredFetchControl> = {};

    const pending = new Promise<Response>((resolve, reject) => {
      control.resolve = () => resolve(mockAudioResponse());
      control.reject = (error = new Error('Deferred fetch rejected')) =>
        reject(error);
    });

    controls.push(control as DeferredFetchControl);

    return pending;
  });

  return {fetchSpy, controls};
}
