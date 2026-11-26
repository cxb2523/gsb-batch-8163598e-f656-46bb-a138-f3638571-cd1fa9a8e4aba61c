# Continue Fold Studio in Codex
Existing application; do not rebuild from scratch. Read README.md, package.json, app.js, layout-workflow.js, engine.js and paper-model.js first.

## Locked product decisions
Automatic local bootstrap: start.cmd on Windows; npm start or node start.mjs on other systems. Installs from lockfile on first run or lockfile changes. Node.js LTS is the prerequisite. Hosted site visitors need only a browser.
English UI. Keep Shape → Artwork → Print short.
Manual Brand/Design editor and built-in generation/API-key UI were deliberately removed.
Workflow: template+prompt → external image editor → upload image → fit ALL faces → 3D → PDF.
Every font letter-spacing is exactly positive 0.04em, fixed, without relative calculations.
Preserve original image; no repeated AI redraws or destructive downsampling.
3D, template and PDF must share paper geometry and mm dimensions.
No unsupported preview-only constructions in the catalog.
Camera rotation uses a stable model pivot; zoom stays centred.
Fit all faces is one undo action. Keep session undo/redo and project persistence.
Never silently shrink physical dimensions to force a net onto A4.

## Source map
app.js: UI/state/wiring.
layout-workflow.js: simplified template/import/print flow.
engine.js: Three.js, camera, face image rendering and PDF.
shapes.js, structures.js, paper-model.js: 18 constructions and geometry.
box-opening.js: opening mechanisms.
net-layout.js, upright-net.js: unfolded placement/orientation.
design-atlas.js, template-prompt.js: PNG template, placement map and prompt.
face-fit.js, fit-face-image.js, artwork-transform.js, artwork-edges.js: source sampling/fitting.
print-sheet.js: actual-size pages/tiling.
project-store.js, project-history.js: save/load/autosave/history.
thumbnails.js: actual geometry thumbnails.

## Known limits and next work
No physical assembly verification despite passing computational audits. Test all forms with real stock/glue/scoring.
External AI may rearrange artwork and ignore rotations; deterministic non-destructive mapping is preferable to AI redraws.
Inspect template-to-face mapping, cap rotations and narrow white seams.
No automated security audit performed for handoff.
Saved user projects live in browser/exported JSON, not this archive.
Clarify upstream permission before public/open-source release.
Do not claim unlimited free AI generation or industrial print certification.
Generated lifestyle images are visual concepts, not photos of manufactured samples.

## Handoff verification
2026-11-16: npm build, regression/construction audit, opening audit, face-fit, artwork-transform and template-prompt audits passed. Re-run commands in README.
Dependency installation requires internet. No server secret or API key is required by this tool.

