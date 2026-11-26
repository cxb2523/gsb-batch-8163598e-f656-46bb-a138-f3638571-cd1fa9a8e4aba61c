import type { PreparedVolumeFor3D, VolumeCursor } from '../../../types';
import type {
  ThreeModule,
  ThreePreviewInstance,
  TrackballControlsModule,
  VolumeShaderModule,
} from '../types';
import {
  applyDistanceLimits,
  cursorToWorldTarget,
  resolveAxisScale,
} from './camera';
import { buildCursorPlanes } from './cursor-planes';
import {
  buildColormap,
  buildMaterial,
  buildTexture,
  buildVolumeMesh,
} from './volume-object';

export type { ThreePreviewInstance } from '../types';

/**
 * Cancellation input for {@link createThreePreview}.
 *
 * The component owns a simple boolean flag and exposes it through
 * `isCancelled`; a standard `AbortSignal` (or any `{ aborted }` object) and
 * a plain `{ cancelled }` token are also accepted for convenience.
 */
export interface CreateThreePreviewOptions {
  signal?: AbortSignal;
  isCancelled?: () => boolean;
}

export type CreateThreePreviewCancellation =
  | AbortSignal
  | CreateThreePreviewOptions
  | (() => boolean)
  | { cancelled?: boolean };

export class PreviewCreationCancelledError extends Error {
  constructor() {
    super('3D preview creation was cancelled before it mounted.');
    this.name = 'AbortError';
  }
}

/**
 * Reads every supported cancellation shape without assuming which one the
 * caller used. Kept defensive so a late caller can never observe a throw from
 * cancellation bookkeeping.
 */
function isCancellationRequested(
  cancellation: CreateThreePreviewCancellation | undefined,
): boolean {
  if (!cancellation) return false;
  try {
    if (typeof cancellation === 'function') {
      return Boolean(cancellation());
    }
    if (typeof cancellation !== 'object') return false;

    const candidate = cancellation as {
      isCancelled?: unknown;
      signal?: { aborted?: boolean };
      aborted?: boolean;
      cancelled?: boolean;
    };

    if (typeof candidate.isCancelled === 'function') {
      return Boolean((candidate.isCancelled as () => boolean)());
    }
    if (candidate.signal && typeof candidate.signal === 'object') {
      return Boolean(candidate.signal.aborted);
    }
    if (typeof candidate.aborted === 'boolean') return candidate.aborted;
    if (typeof candidate.cancelled === 'boolean') return candidate.cancelled;
  } catch {
    // A broken cancellation probe must not block creation.
    return false;
  }
  return false;
}

export async function createThreePreview(
  host: HTMLDivElement,
  volume: PreparedVolumeFor3D,
  cancellation?: CreateThreePreviewCancellation,
): Promise<ThreePreviewInstance> {
  // A switch/unmount can happen before the parallel dynamic imports settle.
  // Bail out here so a cancelled generation never touches the host node.
  if (isCancellationRequested(cancellation)) {
    throw new PreviewCreationCancelledError();
  }

  const [three, trackballControls, volumeShader] = await Promise.all([
    import('three'),
    import('three/addons/controls/TrackballControls.js'),
    import('three/addons/shaders/VolumeShader.js'),
  ]);

  // The imports cannot truly be aborted, so re-check once they resolve. When
  // cancelled at this point we skip buildPreview() entirely, meaning no
  // renderer/canvas is created and nothing is appended to the host.
  if (isCancellationRequested(cancellation)) {
    throw new PreviewCreationCancelledError();
  }

  return buildPreview(three, trackballControls, volumeShader, host, volume);
}

function buildPreview(
  three: ThreeModule,
  trackballControls: TrackballControlsModule,
  volumeShader: VolumeShaderModule,
  host: HTMLDivElement,
  volume: PreparedVolumeFor3D,
): ThreePreviewInstance {
  host.replaceChildren();

  const scene = new three.Scene();
  scene.background = new three.Color(0x050b13);

  const renderer = new three.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2.5));
  renderer.setSize(
    Math.max(1, host.clientWidth),
    Math.max(1, host.clientHeight),
    false,
  );
  renderer.outputColorSpace = three.SRGBColorSpace;
  renderer.setClearColor(0x050b13, 1);
  host.appendChild(renderer.domElement);

  const camera = new three.PerspectiveCamera(
    12,
    Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight),
    0.1,
    500,
  );

  const controls = new trackballControls.TrackballControls(
    camera,
    renderer.domElement,
  );
  controls.rotateSpeed = 0.95;
  controls.zoomSpeed = 1.05;
  controls.panSpeed = 0.3;
  controls.dynamicDampingFactor = 0.18;
  const motionPreference = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  );
  const syncMotionPreference = () => {
    controls.staticMoving = motionPreference.matches;
  };
  syncMotionPreference();
  motionPreference.addEventListener('change', syncMotionPreference);
  controls.noPan = true;
  controls.minDistance = 1.2;
  controls.maxDistance = 10;

  const texture = buildTexture(three, volume);
  const colormap = buildColormap(three);
  const material = buildMaterial(
    three,
    volumeShader,
    volume,
    texture,
    colormap,
  );
  const mesh = buildVolumeMesh(three, volume, material);
  scene.add(mesh);

  const axisScale = resolveAxisScale(volume.spacing);
  mesh.scale.set(axisScale[0], axisScale[1], axisScale[2]);

  const worldSize = [
    Math.max(1, volume.dimensions[0] - 1) * axisScale[0],
    Math.max(1, volume.dimensions[1] - 1) * axisScale[1],
    Math.max(1, volume.dimensions[2] - 1) * axisScale[2],
  ] as const;
  const maxWorldEdge = Math.max(...worldSize) || 1;

  const center = new three.Vector3(
    ((volume.dimensions[0] - 1) / 2) * axisScale[0],
    ((volume.dimensions[1] - 1) / 2) * axisScale[1],
    ((volume.dimensions[2] - 1) / 2) * axisScale[2],
  );
  const cursorPlanes = buildCursorPlanes(three, worldSize, center);
  scene.add(cursorPlanes.root);
  camera.near = Math.max(0.1, maxWorldEdge / 2048);

  const initialTarget = center.clone();
  const initialOffset = new three.Vector3(
    maxWorldEdge * 0.68,
    -maxWorldEdge * 2.9,
    maxWorldEdge * 4.25,
  );
  let currentTarget = initialTarget.clone();
  const resetView = () => {
    camera.up.set(0, 1, 0);
    camera.position.copy(currentTarget).add(initialOffset);
    camera.lookAt(currentTarget);
    applyDistanceLimits(camera, controls, worldSize, currentTarget);
    controls.target.copy(currentTarget);
    cursorPlanes.update(currentTarget);
    controls.update();
  };
  resetView();

  let disposed = false;
  let frame = 0;
  const resizeObserver = new ResizeObserver(() => {
    if (disposed) return;
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    controls.handleResize();
  });
  resizeObserver.observe(host);
  controls.handleResize();

  const render = () => {
    if (disposed) return;
    frame = window.requestAnimationFrame(render);
    controls.update();
    renderer.render(scene, camera);
  };
  render();

  const safeDispose = (
    resource: { dispose?: () => void } | null | undefined,
  ) => {
    try {
      resource?.dispose?.();
    } catch {
      // Disposal must never throw; remaining resources still need release.
    }
  };

  function dispose() {
    // Repeatable disposal: the second and later calls are exact no-ops so
    // callers can dispose from both the async cancellation path and unmount.
    if (disposed) return;
    disposed = true;

    window.cancelAnimationFrame(frame);

    try {
      motionPreference.removeEventListener('change', syncMotionPreference);
    } catch {
      /* listener already gone */
    }
    try {
      resizeObserver.disconnect();
    } catch {
      /* observer already disconnected */
    }

    // Every GPU resource below is created exactly once and released once;
    // safeDispose keeps an individual failure from skipping the rest.
    safeDispose(controls);
    safeDispose(mesh.geometry);
    safeDispose(material);
    safeDispose(cursorPlanes);
    safeDispose(texture);
    safeDispose(colormap);

    // Remove only this instance's own canvas. A newer preview may already own
    // the shared host; an unconditional host.replaceChildren() here would
    // destroy the fresh canvas (the stacked/missing-preview race).
    const canvas = renderer.domElement;
    try {
      if (canvas && canvas.parentElement === host) {
        host.removeChild(canvas);
      }
    } catch {
      /* canvas already removed */
    }

    safeDispose(renderer);
    try {
      renderer.forceContextLoss?.();
    } catch {
      /* context already lost */
    }
  }

  return {
    focusCursor(cursor: VolumeCursor | null) {
      if (!cursor) {
        currentTarget = initialTarget.clone();
        cursorPlanes.update(currentTarget);
        return;
      }

      const target = cursorToWorldTarget(three, volume, axisScale, cursor);
      currentTarget = target;
      applyDistanceLimits(camera, controls, worldSize, currentTarget);
      controls.target.copy(currentTarget);
      cursorPlanes.update(currentTarget);
      camera.lookAt(currentTarget);
      controls.update();
    },
    resetView,
    rotateView(horizontalRadians, verticalRadians) {
      const offset = camera.position.clone().sub(currentTarget);
      const spherical = new three.Spherical().setFromVector3(offset);
      spherical.theta += horizontalRadians;
      spherical.phi = Math.min(
        Math.PI - 0.05,
        Math.max(0.05, spherical.phi + verticalRadians),
      );
      offset.setFromSpherical(spherical);
      camera.up.set(0, 1, 0);
      camera.position.copy(currentTarget).add(offset);
      camera.lookAt(currentTarget);
      controls.target.copy(currentTarget);
      controls.update();
    },
    setPlanesVisible(visible) {
      cursorPlanes.root.visible = visible;
    },
    zoomView(factor) {
      const offset = camera.position.clone().sub(currentTarget);
      const distance = Math.min(
        controls.maxDistance,
        Math.max(controls.minDistance, offset.length() * factor),
      );
      offset.setLength(distance);
      camera.position.copy(currentTarget).add(offset);
      camera.lookAt(currentTarget);
      controls.target.copy(currentTarget);
      controls.update();
    },
    dispose,
  };
}
