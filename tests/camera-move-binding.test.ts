import test from 'node:test';
import assert from 'node:assert/strict';
import { clone, demoProject, entity, type Entity, type Project, type Vec3 } from '../src/core/model.ts';
import { SceneSession } from '../src/core/scenes/sequence-session.ts';
import { cameraPresetPath } from '../src/core/cinematography/camera-presets.ts';
import {
    bakeCameraMove,
    cameraMoveIssue,
    invalidateCameraMovesForEntity,
    moveSubjectAt,
    regenerateCameraMove,
    resolveMovePanelSelection,
} from '../src/core/cinematography/camera-move-binding.ts';

const near = (actual: Vec3, expected: Vec3, tolerance = 1e-7) =>
    actual.forEach((value, i) =>
        assert.ok(Math.abs(value - expected[i]) <= tolerance, `${actual.join(',')} ≠ ${expected.join(',')}`),
    );

/** Two moving subjects with distinct trajectories so a stale bake is obvious. */
function fixture() {
    const project = demoProject();
    const camera = entity('camera', 'camera', '测试机位', [3, 2, 6]);
    camera.id = 'cam-test';
    const subjectA = entity('actor', 'person', '主体 A', [0, 0, 0]);
    subjectA.id = 'subject-a';
    subjectA.path = {
        smooth: true,
        points: [
            { time: 0, position: [0, 0, 0] },
            { time: 10, position: [2, 0, 0] },
        ],
    };
    const subjectB = entity('actor', 'person', '主体 B', [5, 0, -2]);
    subjectB.id = 'subject-b';
    subjectB.path = {
        smooth: true,
        points: [
            { time: 0, position: [5, 0, -2] },
            { time: 10, position: [5, 0, 3] },
        ],
    };
    const occluder = entity('prop', 'bench', '遮挡物', [1, 1, 3]);
    occluder.id = 'occluder-1';
    project.entities.push(camera, subjectA, subjectB, occluder);
    return { project, camera, subjectA, subjectB, occluder };
}

function bakeFollow(_project: Project, camera: Entity, subject: Entity, preset = 'follow') {
    return bakeCameraMove(camera, {
        preset,
        start: [3, 2, 6],
        from: 2,
        duration: 4,
        focal: 50,
        subjectId: subject.id,
        subjectAt: (time) => moveSubjectAt(camera, subject, time),
    });
}

test('switching the subject re-bakes look keys onto the new trajectory and preserves timing/focal', () => {
    const { project, camera, subjectA, subjectB } = fixture();
    bakeFollow(project, camera, subjectA);
    const oldEnd = [...camera.camera!.targetPath!.points.at(-1)!.position];

    const result = regenerateCameraMove(project, camera, { subjectId: subjectB.id });

    assert.equal(camera.camera!.moveBinding!.subjectId, subjectB.id);
    assert.equal(camera.camera!.moveBinding!.from, 2);
    assert.equal(camera.camera!.moveBinding!.duration, 4);
    assert.equal(camera.camera!.moveBinding!.focal, 50);
    assert.equal(camera.camera!.focal, 50);
    assert.deepEqual(camera.camera!.moveBinding!.start, [3, 2, 6]);

    const look = camera.camera!.targetPath!;
    assert.equal(look.points[0].time, 2);
    assert.equal(look.points.at(-1)!.time, 6);
    // Every look key follows the NEW subject at its own sample time.
    for (const point of look.points) near(point.position, moveSubjectAt(camera, subjectB, point.time));
    near(look.points.at(-1)!.position, moveSubjectAt(camera, subjectB, 6));
    // The endpoint actually moved away from the old subject's bake.
    assert.ok(oldEnd.some((v, i) => Math.abs(v - look.points.at(-1)!.position[i]) > 0.5));
    assert.equal(result.binding.subjectId, subjectB.id);
});

test('follow/orbit endpoints keep the original camera-subject offset against the new subject', () => {
    const { project, camera, subjectB } = fixture();
    for (const preset of ['follow', 'orbit'] as const) {
        bakeFollow(project, camera, subjectB, preset);
        regenerateCameraMove(project, camera, { subjectId: subjectB.id });
        const path = camera.path!;
        const endOffset = path.points.at(-1)!.position.map((v, i) => v - moveSubjectAt(camera, subjectB, 6)[i]);
        const startOffset = path.points[0].position.map((v, i) => v - moveSubjectAt(camera, subjectB, 2)[i]);
        near(endOffset as Vec3, startOffset as Vec3, 1e-6);
    }
});

test('repeated re-bakes replace keys instead of accumulating duplicates', () => {
    const { project, camera, subjectA, subjectB } = fixture();
    bakeFollow(project, camera, subjectA, 'orbit');
    for (const id of [subjectB.id, subjectA.id, subjectB.id]) {
        regenerateCameraMove(project, camera, { subjectId: id });
        assert.equal(camera.path!.points.length, 65);
        assert.equal(camera.camera!.targetPath!.points.length, 65);
        const times = camera.path!.points.map((p) => p.time);
        assert.deepEqual(
            [...times].sort((a, b) => a - b),
            times,
        );
        assert.equal(new Set(times).size, times.length);
    }
});

test('re-baking a zoom move preserves focal keys and timing', () => {
    const { project, camera } = fixture();
    bakeCameraMove(camera, { preset: 'zoom-in', start: [3, 2, 6], from: 3, duration: 4, focal: 50 });
    const keysBefore = structuredClone(camera.camera!.focalKeys);
    regenerateCameraMove(project, camera, {});
    assert.deepEqual(camera.camera!.focalKeys, keysBefore);
    assert.equal(camera.camera!.focalKeys!.at(-1)!.time, 7);
});

test('deleted subject detaches the stale path and reports a visible issue', () => {
    const { project, camera, subjectA } = fixture();
    bakeFollow(project, camera, subjectA);
    assert.ok(camera.path && camera.camera!.targetPath);

    project.entities = project.entities.filter((e) => e.id !== subjectA.id);
    const affected = invalidateCameraMovesForEntity(project, subjectA.id, 'deleted');

    assert.deepEqual(affected, [camera.id]);
    assert.equal(camera.path, null);
    assert.equal(camera.camera!.targetPath, null);
    assert.equal(camera.camera!.aim, 'manual');
    assert.equal(camera.camera!.moveBinding!.invalidReason, 'subject-deleted');
    const issue = cameraMoveIssue(project, camera)!;
    assert.equal(issue.role, 'subject');
    assert.equal(issue.reason, 'deleted');
    assert.match(issue.message, /删除/);
});

test('hidden subject invalidates the move; visible subjects are fine', () => {
    const { project, camera, subjectA } = fixture();
    bakeFollow(project, camera, subjectA);

    subjectA.visible = false;
    invalidateCameraMovesForEntity(project, subjectA.id, 'hidden');
    assert.equal(camera.path, null);
    assert.equal(camera.camera!.moveBinding!.invalidReason, 'subject-hidden');
    assert.equal(cameraMoveIssue(project, camera)?.reason, 'hidden');

    // Showing the entity again clears the live issue even before re-baking.
    subjectA.visible = true;
    assert.equal(cameraMoveIssue(project, camera), null);
});

test('locked cameras are skipped by invalidation unless explicitly included', () => {
    const { project, camera, subjectA } = fixture();
    bakeFollow(project, camera, subjectA);
    camera.locked = true;
    assert.deepEqual(invalidateCameraMovesForEntity(project, subjectA.id, 'deleted'), []);
    assert.ok(camera.path);
    assert.deepEqual(invalidateCameraMovesForEntity(project, subjectA.id, 'deleted', { includeLocked: true }), [
        camera.id,
    ]);
    assert.equal(camera.path, null);
});

test('foreground occluder bounds drive the bake; missing foreground still throws', () => {
    const { project, camera, occluder } = fixture();
    const foreground = { center: [1, 1, 3] as Vec3, radius: 0.5 };
    bakeCameraMove(camera, {
        preset: 'foreground-wipe',
        start: [3, 2, 6],
        from: 0,
        duration: 4,
        focal: 50,
        foregroundId: occluder.id,
        foreground,
    });
    const closest = Math.min(
        ...camera.path!.points.map((p) => Math.hypot(p.position[0] - 1, p.position[1] - 1, p.position[2] - 3)),
    );
    // The curve crosses just behind the chosen occluder, within a couple of its radii.
    assert.ok(closest < foreground.radius * 2, `closest=${closest}`);

    // Re-bake through a bounds resolver (the host supplies real world bounds this way).
    const resolved = regenerateCameraMove(project, camera, {
        foregroundId: occluder.id,
        foreground: null,
        foregroundBounds: (entity) => (entity.id === occluder.id ? { center: [1, 1, 3], radius: 0.5 } : null),
    });
    assert.equal(resolved.binding.foregroundId, occluder.id);
    assert.ok(resolved.camera.path!.points.length > 0);

    // Without real foreground context the preset keeps its original error contract.
    assert.throws(() => regenerateCameraMove(project, camera, { foreground: null }), /遮挡物/);
    assert.throws(() => cameraPresetPath('foreground-wipe', [3, 2, 6], [0, 1, 0], 0, 4, 50), /遮挡物/);
});

test('subject switch is one undoable edit that restores the original path exactly', () => {
    const { project } = fixture();
    const history = new SceneSession(project);

    let tx = history.begin();
    let draft = clone(tx.project);
    bakeFollow(
        draft,
        draft.entities.find((e) => e.id === 'cam-test')!,
        draft.entities.find((e) => e.id === 'subject-a')!,
    );
    history.commit(tx, draft, '应用运镜');

    const baked = history.project().entities.find((e) => e.id === 'cam-test')!;
    const originalPath = structuredClone(baked.path);
    const originalLook = structuredClone(baked.camera!.targetPath);
    assert.ok(originalPath);

    tx = history.begin();
    const next = clone(tx.project);
    regenerateCameraMove(next, 'cam-test', { subjectId: 'subject-b' });
    history.commit(tx, next, '更换跟拍主体');

    const rebound = history.project().entities.find((e) => e.id === 'cam-test')!;
    assert.notDeepEqual(rebound.path, originalPath);
    assert.equal(rebound.camera!.moveBinding!.subjectId, 'subject-b');

    assert.ok(history.undo());
    const restored = history.project().entities.find((e) => e.id === 'cam-test')!;
    assert.deepEqual(restored.path, originalPath);
    assert.deepEqual(restored.camera!.targetPath, originalLook);
    assert.equal(restored.camera!.moveBinding!.subjectId, 'subject-a');
});

test('panel selection stays bound to each camera instead of leaking the previous camera subject', () => {
    const { project } = fixture();
    const camA = entity('camera', 'camera', 'A', [0, 1, 0]);
    camA.id = 'cam-a';
    const camB = entity('camera', 'camera', 'B', [0, 1, 0]);
    camB.id = 'cam-b';
    const starA = entity('actor', 'person', '专属 A', [2, 0, 0]);
    starA.id = 'star-a';
    const starB = entity('actor', 'person', '专属 B', [-2, 0, 0]);
    starB.id = 'star-b';
    project.entities.push(camA, camB, starA, starB);
    bakeFollow(project, camA, starA, 'orbit');
    bakeFollow(project, camB, starB, 'orbit');

    assert.equal(resolveMovePanelSelection(project, camA).subjectId, 'star-a');
    assert.equal(resolveMovePanelSelection(project, camB).subjectId, 'star-b');
    // A stale explicit pick that no longer exists falls back to that camera's own binding.
    assert.equal(resolveMovePanelSelection(project, camB, { subjectId: 'deleted-choice' }).subjectId, 'star-b');
});
