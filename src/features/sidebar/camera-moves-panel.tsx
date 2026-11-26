import { useState } from 'react';
import { Alert, Button, Empty, Select } from 'antd';
import { CameraPresetPicker } from '@/features/timeline/preset-picker.tsx';
import { useTranslation } from '@/shared/i18n/use-translation.ts';
import { session } from '@/state/editor-session.ts';
import { useEditorStore } from '@/state/editor-store.ts';
import { useProject } from '@/state/use-editor.ts';
import {
    cameraMoveIssue,
    presetUsesForeground,
    presetUsesSubject,
    resolveMovePanelSelection,
} from '@/core/cinematography/camera-move-binding.ts';

/** Camera moves edit an existing camera; placement presets create a new one. */
export function CameraMovesPanel() {
    const t = useTranslation();
    const project = useProject();
    const selected = useEditorStore((state) => state.selected);
    const preview = useEditorStore((state) => state.preview);
    const cameras = project.entities.filter((entity) => entity.camera);
    const camera =
        cameras.find((entity) => entity.id === selected) ??
        cameras.find((entity) => entity.id === preview) ??
        cameras[0];

    // Local picks are explicit overrides; reset them whenever the displayed camera changes so one
    // camera's subject/occluder can never be misapplied to another camera.
    const [panelCameraId, setPanelCameraId] = useState<string | undefined>(camera?.id);
    const [chosenSubject, setSubject] = useState<string>();
    const [chosenForeground, setForeground] = useState<string>();
    if (camera && camera.id !== panelCameraId) {
        setPanelCameraId(camera.id);
        setSubject(undefined);
        setForeground(undefined);
    }

    const binding = camera?.camera?.moveBinding ?? undefined;
    const { subjects, foregrounds, subjectId, foregroundId } = resolveMovePanelSelection(project, camera, {
        subjectId: chosenSubject,
        foregroundId: chosenForeground,
    });

    if (!camera)
        return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('先添加一个机位，再为它设置运镜')} />;

    const issue = cameraMoveIssue(project, camera);
    const linkedSubjectMove = !!binding && presetUsesSubject(binding.preset);
    const linkedForegroundMove = !!binding && presetUsesForeground(binding.preset);
    // A binding whose keys were detached (deleted/hidden subject) can be re-baked once the panel
    // resolves a usable subject again.
    const canRebake = !!binding && !camera.locked && (!camera.path || !!issue || binding.invalidReason);
    const rebakeReady = (!linkedSubjectMove || !!subjectId) && (!linkedForegroundMove || !!foregroundId);
    const rebake = () =>
        session.rebindCameraMove(camera.id, {
            // Prefer the dropdown-resolved replacement when the stored id is already gone.
            ...(linkedSubjectMove ? { subjectId: subjectId ?? null } : {}),
            ...(linkedForegroundMove ? { foregroundId: foregroundId ?? null } : {}),
        });

    const issueText = issue
        ? issue.role === 'subject'
            ? issue.reason === 'deleted'
                ? t('跟拍主体已删除：旧运镜路径已停用，请重新选择主体')
                : t('跟拍主体已隐藏：旧运镜路径已停用，恢复显示或重选主体')
            : issue.reason === 'deleted'
              ? t('前景遮挡物已删除：旧运镜路径已停用，请重新选择遮挡物')
              : t('前景遮挡物已隐藏：旧运镜路径已停用，恢复显示或重选遮挡物')
        : binding?.invalidReason
          ? t('运镜引用的对象已失效，旧路径已停用')
          : null;

    return (
        <div className="camera-moves-panel stack">
            <label className="field-row">
                <span className="field-row__label">{t('拍摄机位')}</span>
                <Select
                    size="small"
                    aria-label={t('运镜机位')}
                    value={camera.id}
                    options={cameras.map((entity) => ({ value: entity.id, label: entity.name }))}
                    onChange={(id) => {
                        session.selectEntity(id);
                        session.setPreview(id);
                    }}
                />
            </label>
            {issueText ? (
                <Alert
                    type="warning"
                    showIcon
                    role="alert"
                    className="camera-moves-panel__warning"
                    message={issueText}
                    action={
                        canRebake && rebakeReady ? (
                            <Button size="small" onClick={rebake}>
                                {t('重新生成')}
                            </Button>
                        ) : undefined
                    }
                />
            ) : null}
            <label className="field-row">
                <span className="field-row__label">{t('跟拍主体')}</span>
                <Select
                    size="small"
                    aria-label={t('跟拍主体')}
                    value={subjectId}
                    placeholder={t('请选择主体')}
                    options={subjects.map((entity) => ({ value: entity.id, label: entity.name }))}
                    onChange={(id) => {
                        setSubject(id);
                        // Switching the subject of an existing subject-tracking bake re-bakes the
                        // path and look keys immediately as one undoable edit.
                        if (linkedSubjectMove && !camera.locked) {
                            const ok = session.rebindCameraMove(camera.id, { subjectId: id });
                            // A rejected re-bake keeps the stored binding; drop the optimistic pick
                            // so the dropdown falls back to the entity the project still holds.
                            if (!ok) setSubject(undefined);
                        }
                    }}
                />
            </label>
            <label className="field-row">
                <span className="field-row__label">{t('前景遮挡物')}</span>
                <Select
                    size="small"
                    allowClear
                    aria-label={t('前景遮挡物')}
                    value={foregroundId}
                    placeholder={t('前景运镜需要选择遮挡物')}
                    options={foregrounds.map((entity) => ({ value: entity.id, label: entity.name }))}
                    onChange={(id) => {
                        setForeground(id);
                        if (linkedForegroundMove && !camera.locked) {
                            const ok = session.rebindCameraMove(camera.id, { foregroundId: id ?? null });
                            if (!ok) setForeground(undefined);
                        }
                    }}
                />
            </label>
            {canRebake && !issueText && rebakeReady ? (
                <Button size="small" onClick={rebake}>
                    {t('按当前主体重新生成运镜')}
                </Button>
            ) : null}
            <p className="muted small camera-moves-panel__hint">
                {camera.locked ? t('当前机位已锁定，解锁后可应用运镜') : t('从当前时间开始，时长 4 秒')}
                {!camera.locked && camera.path ? (
                    <>
                        <br />
                        {t('应用预设会替换此机位的现有运镜')}
                    </>
                ) : null}
                {!camera.locked && linkedSubjectMove ? (
                    <>
                        <br />
                        {t('更换跟拍主体会按新主体重新生成路径，可撤销恢复')}
                    </>
                ) : null}
            </p>
            <CameraPresetPicker
                inline
                disabled={camera.locked}
                hasSubject={!!subjectId}
                hasForeground={!!foregroundId}
                onChoose={(id) => {
                    if (session.applyCameraPreset(id, camera.id, { subjectId, foregroundId })) {
                        session.selectEntity(camera.id);
                        session.setInspectorTab('camera');
                        if (useEditorStore.getState().view === 'stage') session.setView('pip');
                    }
                }}
            />
        </div>
    );
}
