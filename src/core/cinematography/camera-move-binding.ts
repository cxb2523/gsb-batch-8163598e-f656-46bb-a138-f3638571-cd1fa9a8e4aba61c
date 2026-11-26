import * as THREE from 'three';
import { CAMERA_PRESETS, cameraPresetPath, type CameraMoveContext } from './camera-presets.ts';
import { entityPosition, entityYaw } from '../timeline.ts';
import type { CameraMoveBinding, CameraMoveInvalidReason, Entity, Project, Vec3 } from '../model.ts';

/**
 * Link between a baked preset move and the entities it samples.
 *
 * The bake itself is produced exclusively by {@link cameraPresetPath}; this module only remembers
 * its inputs, resolves scene entities to `subjectAt`/foreground contexts and replaces the baked
 * keys as one transaction-sized mutation. Playback, scrubbing and export keep reading the same
 * baked `entity.path` / `camera.targetPath`, so they can never disagree.
 */

export const SUBJECT_CAMERA_PRESET_IDS = CAMERA_PRESETS.filter((p) => 'subject' in p).map((p) => p.id);
export const FOREGROUND_CAMERA_PRESET_IDS = CAMERA_PRESETS.filter((p) => 'foreground' in p).map((p) => p.id);

export function presetUsesSubject(presetId: string): boolean {
    return SUBJECT_CAMERA_PRESET_IDS.includes(presetId as (typeof SUBJECT_CAMERA_PRESET_IDS)[number]);
}

export function presetUsesForeground(presetId: string): boolean {
    return FOREGROUND_CAMERA_PRESET_IDS.includes(presetId as (typeof FOREGROUND_CAMERA_PRESET_IDS)[number]);
}

/** Whether a camera has a preset bake that can be regenerated from its binding. */
export function isBoundCameraMove(camera: Entity | undefined | null): camera is Entity & {
    camera: NonNullable<Entity['camera']> & { moveBinding: CameraMoveBinding };
} {
    return !!camera?.camera?.moveBinding && !!camera.camera.moveBinding.preset;
}

/** True when either the bake recipe or the legacy look-at target references `entityId`. */
export function cameraMoveReferencesEntity(camera: Entity, entityId: string): boolean {
    if (!camera.camera) return false;
    const binding = camera.camera.moveBinding;
    return camera.camera.targetId === entityId || binding?.subjectId === entityId || binding?.foregroundId === entityId;
}

/** Height added above the subject origin when aiming; matches the original preset bake. */
export function moveSubjectHeight(camera: Entity, subject: Entity): number {
    const config = camera.camera;
    if (config?.targetId === subject.id) return config.targetHeight;
    return (subject.height ?? 1.7) * 0.65;
}

/** World-space followed point (subject origin plus the framing height) at time `time`. */
export function moveSubjectAt(camera: Entity, subject: Entity, time: number): Vec3 {
    return entityPosition(subject, time)
        .add(new THREE.Vector3(0, moveSubjectHeight(camera, subject), 0))
        .toArray() as Vec3;
}

export interface CameraMoveIssue {
    role: 'subject' | 'foreground';
    entityId: string;
    reason: 'deleted' | 'hidden';
    /** Stable Chinese copy for panels/tests; UI may map this through its i18n dictionary. */
    message: string;
}

const ISSUE_MESSAGES: Record<`${CameraMoveIssue['role']}-${CameraMoveIssue['reason']}`, string> = {
    'subject-deleted': '跟拍主体已删除，已停止沿用旧运镜路径',
    'subject-hidden': '跟拍主体已隐藏，已停止沿用旧运镜路径',
    'foreground-deleted': '前景遮挡物已删除，已停止沿用旧运镜路径',
    'foreground-hidden': '前景遮挡物已隐藏，已停止沿用旧运镜路径',
};

/**
 * Live validity of a camera's move references. Derived from project entities first so projects
 * saved with a dangling id or changes made outside the commands are detected as well.
 */
export function cameraMoveIssue(project: Pick<Project, 'entities'>, camera: Entity): CameraMoveIssue | null {
    const binding = camera.camera?.moveBinding;
    const check = (
        role: CameraMoveIssue['role'],
        entityId: string | undefined,
        stored?: CameraMoveInvalidReason,
    ): CameraMoveIssue | null => {
        if (!entityId) return null;
        const entity = project.entities.find((item) => item.id === entityId);
        const reason: CameraMoveIssue['reason'] | null = !entity ? 'deleted' : entity.visible ? null : 'hidden';
        if (!reason) return null;
        const key = `${role}-${reason}` as const;
        return { role, entityId, reason, message: ISSUE_MESSAGES[key] ?? stored ?? key };
    };
    return (
        check('subject', binding?.subjectId, binding?.invalidReason) ??
        check('foreground', binding?.foregroundId, binding?.invalidReason)
    );
}

/** Detach baked keys that point at a missing/hidden entity and record why for the panel. */
export function invalidateCameraMove(camera: Entity, reason: CameraMoveInvalidReason): boolean {
    const config = camera.camera;
    if (!config?.moveBinding) return false;
    config.moveBinding = { ...config.moveBinding, invalidReason: reason };
    // If an engine-backed freeze did not run first, keep the final framed orientation instead of
    // snapping back to a stale entity rotation once aim switches to manual.
    const alreadyFrozen = config.aim === 'manual';
    if (!alreadyFrozen) {
        const lastLook = config.targetPath?.points.at(-1)?.position;
        if (lastLook) {
            const matrix = new THREE.Matrix4().lookAt(
                new THREE.Vector3(...camera.position),
                new THREE.Vector3(...lastLook),
                new THREE.Vector3(0, 1, 0),
            );
            const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(matrix));
            camera.rotation = [euler.x, euler.y, euler.z];
        }
    }
    // Drop the stale bake outright: playback, scrub and export all read these same fields.
    camera.path = null;
    config.targetPath = null;
    config.targetId = '';
    config.mode = 'free';
    config.aim = 'manual';
    return true;
}

/**
 * Invalidate every unlocked camera move referencing `entityId`. Locked cameras are skipped because
 * the history invariant rejects any mutation of a locked entity; callers that can freeze a camera
 * through the engine should do so before invoking this sweep.
 *
 * Returns the affected camera ids.
 */
export function invalidateCameraMovesForEntity(
    project: Project,
    entityId: string,
    cause: 'deleted' | 'hidden' = 'deleted',
    options: { includeLocked?: boolean } = {},
): string[] {
    const affected: string[] = [];
    for (const camera of project.entities) {
        if (camera.kind !== 'camera' || !camera.camera?.moveBinding) continue;
        if (camera.locked && !options.includeLocked) continue;
        const binding = camera.camera.moveBinding;
        let reason: CameraMoveInvalidReason | null = null;
        if (binding.subjectId === entityId) reason = cause === 'deleted' ? 'subject-deleted' : 'subject-hidden';
        else if (binding.foregroundId === entityId)
            reason = cause === 'deleted' ? 'foreground-deleted' : 'foreground-hidden';
        if (reason && invalidateCameraMove(camera, reason)) affected.push(camera.id);
    }
    return affected;
}

export interface BakeCameraMoveInput {
    preset: string;
    start: Vec3;
    from: number;
    duration: number;
    focal: number;
    /** Entity ids are persisted in the binding even when their sampled context is supplied. */
    subjectId?: string;
    foregroundId?: string;
    subjectAt?: (time: number) => Vec3;
    subjectYaw?: number;
    foreground?: CameraMoveContext['foreground'];
}

export interface BakedCameraMove {
    binding: CameraMoveBinding;
    motion: ReturnType<typeof cameraPresetPath>;
}

/**
 * Run {@link cameraPresetPath} and commit its path/look/focal keys onto the camera, replacing all
 * prior keys in one assignment. Also stores the regeneration recipe. Apply and re-bake therefore
 * write keys the same way; the command layer owns the initial live-camera start/focal resolution.
 */
export function bakeCameraMove(camera: Entity, input: BakeCameraMoveInput): BakedCameraMove {
    const config = camera.camera;
    if (!config) throw new Error('实体不是机位');
    const context: CameraMoveContext = {
        ...(input.subjectAt ? { subjectAt: input.subjectAt } : {}),
        ...(input.subjectYaw !== undefined ? { subjectYaw: input.subjectYaw } : {}),
        ...(input.foreground ? { foreground: input.foreground } : {}),
    };
    const motion = cameraPresetPath(
        input.preset as Parameters<typeof cameraPresetPath>[0],
        [...input.start],
        // The static `target` argument only seeds non-subject presets; subject presets immediately
        // re-base onto subjectAt(from), so the stored aim point is a safe fallback.
        input.subjectAt ? input.subjectAt(input.from) : [...config.target],
        input.from,
        input.duration,
        input.focal,
        context,
    );
    camera.position = [...input.start];
    camera.path = motion.path;
    config.mode = 'free';
    config.aim = 'target';
    config.targetId = '';
    config.target = motion.targetPath.points[0]
        ? [...motion.targetPath.points[0].position]
        : input.subjectAt
          ? input.subjectAt(input.from)
          : [...config.target];
    config.targetPath = motion.targetPath;
    config.focal = input.focal;
    if (motion.focalKeys) config.focalKeys = motion.focalKeys;
    else delete config.focalKeys;
    const binding: CameraMoveBinding = {
        preset: input.preset,
        ...(input.subjectId ? { subjectId: input.subjectId } : {}),
        ...(input.foregroundId ? { foregroundId: input.foregroundId } : {}),
        from: input.from,
        duration: input.duration,
        focal: input.focal,
        start: [...input.start],
    };
    config.moveBinding = binding;
    return { binding, motion };
}

export interface RegenerateCameraMoveOptions {
    /** New follow subject; omit to keep the binding's subject, pass null to clear. */
    subjectId?: string | null;
    /** New foreground occluder; omit to keep the binding's occluder, pass null to clear. */
    foregroundId?: string | null;
    /** Real occluder bounds (world center + bounding radius), supplied by the engine/host. */
    foreground?: CameraMoveContext['foreground'] | null;
    /** Resolve occluder bounds from an entity when `foreground` is not given directly. */
    foregroundBounds?: (foreground: Entity) => CameraMoveContext['foreground'] | null;
    /** Override the baked start position; defaults to the stored start / first key. */
    start?: Vec3;
    /** Override subject yaw; defaults to the project-sampled yaw. */
    subjectYaw?: number;
}

export interface RegeneratedCameraMove {
    camera: Entity;
    binding: CameraMoveBinding;
    motion: ReturnType<typeof cameraPresetPath>;
    subject?: Entity;
    foreground?: Entity;
}

function resolveCamera(project: Project, cameraIdOrEntity: string | Entity): Entity {
    const camera =
        typeof cameraIdOrEntity === 'string'
            ? project.entities.find((entity) => entity.id === cameraIdOrEntity)
            : cameraIdOrEntity;
    if (!camera?.camera) throw new Error('未找到可用的机位');
    return camera;
}

/**
 * Re-bake a bound camera move after its subject/occluder changed, reusing the original start
 * time, duration, focal length and start position. Pure project mutation: callers wrap it in one
 * history transaction to make the switch undoable.
 */
export function regenerateCameraMove(
    project: Project,
    cameraIdOrEntity: string | Entity,
    options: RegenerateCameraMoveOptions | string = {},
): RegeneratedCameraMove {
    const opts: RegenerateCameraMoveOptions = typeof options === 'string' ? { subjectId: options } : options;
    const camera = resolveCamera(project, cameraIdOrEntity);
    const previous = camera.camera!.moveBinding;
    if (!previous?.preset) throw new Error('当前机位没有可重新生成的运镜预设');

    const subjectId = opts.subjectId === undefined ? previous.subjectId : (opts.subjectId ?? undefined);
    const foregroundId = opts.foregroundId === undefined ? previous.foregroundId : (opts.foregroundId ?? undefined);
    const preset = previous.preset;

    const subject = subjectId
        ? project.entities.find((entity) => entity.id === subjectId && !entity.camera)
        : undefined;
    if (presetUsesSubject(preset) && !subject) throw new Error('请先选择跟拍主体');

    const foreground = foregroundId
        ? project.entities.find((entity) => entity.id === foregroundId && !entity.camera && entity.visible)
        : undefined;
    // A missing occluder only blocks foreground moves (or an explicit occluder re-link); a stale
    // id on an unrelated preset is simply dropped by the new binding below.
    if ((presetUsesForeground(preset) || opts.foregroundId !== undefined) && foregroundId && !foreground)
        throw new Error('请先选择前景遮挡物');
    let foregroundContext: CameraMoveContext['foreground'] | null =
        opts.foreground === undefined ? null : opts.foreground;
    if (presetUsesForeground(preset)) {
        if (!foregroundContext && foreground && opts.foregroundBounds)
            foregroundContext = opts.foregroundBounds(foreground);
        if (!foregroundContext) throw new Error('请先选择前景遮挡物');
    }

    const from = previous.from;
    const duration = previous.duration;
    const focal = previous.focal;
    const start = opts.start ?? previous.start ?? camera.path?.points[0]?.position ?? ([...camera.position] as Vec3);
    const subjectYaw = opts.subjectYaw ?? (subject ? entityYaw(subject, from, project as Project) : undefined);

    const { motion } = bakeCameraMove(camera, {
        preset,
        start,
        from,
        duration,
        focal,
        subjectId: subject?.id,
        foregroundId: foreground?.id,
        subjectAt: subject ? (time) => moveSubjectAt(camera, subject, time) : undefined,
        subjectYaw,
        foreground: foregroundContext ?? undefined,
    });
    return { camera, binding: camera.camera!.moveBinding!, motion, subject, foreground };
}

/** Alias kept for callers that phrase the edit as re-linking the follow target. */
export const rebindCameraMove = regenerateCameraMove;
/** Alias kept for callers that phrase the edit as rebuilding baked keys. */
export const rebuildCameraMove = regenerateCameraMove;
/** Switch only the follow subject of a bound move. */
export function switchCameraSubject(
    project: Project,
    cameraId: string | Entity,
    subjectId: string,
    options: Omit<RegenerateCameraMoveOptions, 'subjectId'> = {},
): RegeneratedCameraMove {
    return regenerateCameraMove(project, cameraId, { ...options, subjectId });
}

export interface MovePanelSelection {
    subjects: Entity[];
    foregrounds: Entity[];
    subjectId?: string;
    foregroundId?: string;
}

/**
 * Resolve the panel's subject/occluder dropdown values for one camera. Explicit local picks win,
 * then the camera's own binding/look target, then the first actor as the apply-time default.
 * Pure so the "switching cameras must not reuse the previous camera's subject" rule is testable.
 */
export function resolveMovePanelSelection(
    project: Pick<Project, 'entities'>,
    camera: Entity | undefined,
    chosen: { subjectId?: string; foregroundId?: string } = {},
): MovePanelSelection {
    const subjects = project.entities.filter((item) => !item.camera && !item.light && item.visible);
    const binding = camera?.camera?.moveBinding;
    const boundSubjectId = binding?.subjectId ?? camera?.camera?.targetId;
    const subjectId =
        subjects.find((item) => item.id === chosen.subjectId)?.id ??
        subjects.find((item) => item.id === boundSubjectId)?.id ??
        subjects.find((item) => item.kind === 'actor')?.id;
    const foregrounds = subjects.filter((item) => item.id !== subjectId);
    const foregroundId =
        foregrounds.find((item) => item.id === chosen.foregroundId)?.id ??
        foregrounds.find((item) => item.id === binding?.foregroundId)?.id;
    return { subjects, foregrounds, subjectId, foregroundId };
}
