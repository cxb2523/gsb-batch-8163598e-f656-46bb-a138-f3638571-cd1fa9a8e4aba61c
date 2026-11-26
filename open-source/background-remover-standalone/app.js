// ============================================================
//  Background Remover — Standalone Open Source Demo
//  AI auto-removal + Manual brush/eraser refinement
//  Uses @imgly/background-removal (ONNX model via WebAssembly)
//
//  Architecture: the alpha-channel mask canvas is the single
//  source of truth. Preview, refine overlay, undo snapshots and
//  the downloaded PNG are all derived from it. Async work is
//  guarded by monotonically increasing tokens so a stale image
//  load or a stale auto-removal run can never commit its result.
// ============================================================

const LIB_CDN = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5';
const MAX_UNDO = 20;
const RED_OVERLAY_THRESHOLD = 128;

// ── State ──────────────────────────────────────────────
let originalImage = null;   // decoded HTMLImageElement for the current upload
let thumbUrl = null;        // object URL backing originalImage / the thumbnail

// The mask canvas stores coverage in its ALPHA channel (RGB is white).
// It is the only editable state: everything else is derived from it.
let maskCanvas = null;
let maskCtx = null;
let origCanvas = null;      // full-resolution copy of originalImage

// [0] is always the auto-removal baseline; the rest are pre-stroke snapshots.
let undoStack = [];

// Lifecycle tokens. Any async continuation compares its captured token
// with the live one and bails out if a newer action has superseded it.
let imageLoadToken = 0;
let removalToken = 0;
let isProcessing = false;   // an auto-removal run is in flight
let isDrawing = false;
let lastX = 0, lastY = 0;

let currentMode = 'preview';
let currentTool = 'brush';

let removeBackgroundFn = null;
let libraryPromise = null;
let renderScheduled = false;

// ── DOM refs ───────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const overlay = $('overlay');
const overlayTitle = $('overlay-title');
const overlayDesc = $('overlay-desc');
const overlayProg = $('overlay-progress');
const overlayStatus = $('overlay-status');

const dropzone = $('dropzone');
const fileInput = $('file-input');
const browseBtn = $('browse-btn');
const uploadZone = $('upload-zone');
const fileInfo = $('file-info');
const fileNameEl = $('file-name');
const fileSizeEl = $('file-size');
const fileDimsEl = $('file-dims');
const fileThumbImg = $('file-thumb-img');
const removeFileBtn = $('remove-file-btn');
const actionBar = $('action-bar');
const autoRemoveBtn = $('auto-remove-btn');

const resultArea = $('result-area');
const canvasWrapper = $('canvas-wrapper');
const previewCanvas = $('preview-canvas');
const editCanvas = $('edit-canvas');
const previewCtx = previewCanvas.getContext('2d');
// The edit overlay is read back every frame while refining, so hint the
// browser to keep it in a CPU-friendly surface.
const editCtx = editCanvas.getContext('2d', { willReadFrequently: true });

const btnPreview = $('btn-preview');
const btnRefine = $('btn-refine');
const btnReprocess = $('btn-reprocess');
const refineToolbar = $('refine-toolbar');
const refineHint = $('refine-hint');

const toolBrush = $('tool-brush');
const toolEraser = $('tool-eraser');
const brushSizeEl = $('brush-size');
const brushSizeVal = $('brush-size-val');
const brushSoftEl = $('brush-softness');
const brushSoftVal = $('brush-softness-val');
const toolUndo = $('tool-undo');

const brushCursor = $('brush-cursor');
const downloadBtn = $('download-btn');
const newBtn = $('new-btn');

// ── Small helpers ──────────────────────────────────────
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function show(el) { if (el) el.classList.remove('hidden'); }
function hide(el) { if (el) el.classList.add('hidden'); }

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode image'));
    img.src = src;
  });
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode image'));
    }, type);
  });
}

// ── Overlay ────────────────────────────────────────────
function showOverlay(title, desc) {
  overlayTitle.textContent = title || 'Loading AI Model...';
  overlayDesc.innerHTML = desc || 'First time takes ~30 seconds.<br>The model is cached for future use.';
  overlayProg.style.width = '0%';
  overlayStatus.textContent = 'Initializing...';
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function hideOverlay() {
  overlay.classList.remove('active');
  document.body.style.overflow = '';
}

function updateOverlayProgress(pct, status) {
  overlayProg.style.width = Math.min(100, pct).toFixed(1) + '%';
  if (status) overlayStatus.textContent = status;
}

// ── Mask state ─────────────────────────────────────────
function snapshotMask() {
  if (!maskCanvas || !maskCtx) return null;
  return maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);
}

// Drops the full-resolution buffers. Canvas backing stores are released by
// sizing them down to zero before references are cleared.
function disposeMaskBuffers() {
  if (origCanvas) { origCanvas.width = 0; origCanvas.height = 0; }
  if (maskCanvas) { maskCanvas.width = 0; maskCanvas.height = 0; }
  origCanvas = null;
  maskCanvas = null;
  maskCtx = null;
  undoStack = [];
  isDrawing = false;
}

function clearDisplayCanvases() {
  previewCanvas.width = 1;
  previewCanvas.height = 1;
  editCanvas.width = 1;
  editCanvas.height = 1;
  previewCtx.clearRect(0, 0, 1, 1);
  editCtx.clearRect(0, 0, 1, 1);
  editCanvas.style.display = 'none';
  brushCursor.style.display = 'none';
}

// Releases everything tied to the currently loaded image: object URL,
// canvas backing stores and undo history.
function releaseImageResources() {
  if (thumbUrl) {
    URL.revokeObjectURL(thumbUrl);
    thumbUrl = null;
  }
  fileThumbImg.removeAttribute('src');
  fileThumbImg.style.display = 'none';
  originalImage = null;
  disposeMaskBuffers();
  clearDisplayCanvases();
}

// ── File handling ──────────────────────────────────────
function handleFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  if (file.size > 20 * 1024 * 1024) {
    alert('File too large. Maximum size is 20 MB.');
    return;
  }

  // Invalidate any pending image load and any in-flight auto-removal for the
  // previous image. Their continuations will see a stale token and bail.
  const token = ++imageLoadToken;
  invalidateRemoval();

  const url = URL.createObjectURL(file);
  const img = new Image();

  img.onload = () => {
    if (token !== imageLoadToken) {
      // A newer file selection (or a reset) won the race.
      URL.revokeObjectURL(url);
      return;
    }

    // Commit the new image atomically, releasing the previous image's
    // object URL, mask and canvas backing stores first.
    releaseImageResources();

    thumbUrl = url;
    originalImage = img;

    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatSize(file.size);
    fileDimsEl.textContent = img.naturalWidth + '×' + img.naturalHeight;
    fileThumbImg.src = url;
    fileThumbImg.style.display = 'block';

    hide(uploadZone);
    show(fileInfo);
    show(actionBar);
    hide(resultArea);
    hide(refineToolbar);
    hide(refineHint);
    setMode('preview');
  };

  img.onerror = () => {
    URL.revokeObjectURL(url);
    if (token === imageLoadToken) {
      alert('Could not read that image. Please try another file.');
    }
  };

  img.src = url;
}

function resetAll() {
  imageLoadToken++;         // discard a pending image decode
  invalidateRemoval();      // discard a pending auto-removal + hide overlay
  releaseImageResources();

  currentMode = 'preview';
  currentTool = 'brush';
  isDrawing = false;

  show(uploadZone);
  hide(fileInfo);
  hide(actionBar);
  hide(resultArea);
  hide(refineToolbar);
  hide(refineHint);
  clearDisplayCanvases();
  fileInput.value = '';

  btnPreview.classList.add('active');
  btnRefine.classList.remove('active');
  toolBrush.classList.add('active');
  toolEraser.classList.remove('active');
}

// Dropzone events
browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

removeFileBtn.addEventListener('click', resetAll);
newBtn.addEventListener('click', resetAll);

// ── Auto removal ───────────────────────────────────────
function ensureRemoveBackground() {
  if (removeBackgroundFn) return Promise.resolve(removeBackgroundFn);

  // Testing/offline seam: a locally injected implementation may be supplied
  // on the global object before running. In production this is undefined and
  // the real library is loaded from the CDN.
  if (typeof window !== 'undefined' && typeof window.removeBackground === 'function') {
    removeBackgroundFn = window.removeBackground;
    return Promise.resolve(removeBackgroundFn);
  }

  if (!libraryPromise) {
    libraryPromise = import(LIB_CDN + '/+esm')
      .then((module) => {
        const fn = module.removeBackground || module.default;
        if (typeof fn !== 'function') {
          throw new Error('removeBackground export was not found in the loaded module');
        }
        removeBackgroundFn = fn;
        return fn;
      })
      .catch((err) => {
        libraryPromise = null;
        throw err;
      });
  }
  return libraryPromise;
}

// Invalidates any in-flight auto-removal. The promise itself cannot be
// aborted (the library has no abort hook), but its continuation is fenced
// off by the token and can never touch state again.
function invalidateRemoval() {
  removalToken++;
  isProcessing = false;
  isDrawing = false;
  hideOverlay();
}

async function runAutoRemoval() {
  const image = originalImage;
  if (!image) return;

  const token = ++removalToken;
  const isCurrent = () => token === removalToken;

  isProcessing = true;
  isDrawing = false;

  try {
    showOverlay('Loading AI Model...', 'First time takes ~30 seconds.<br>The model is cached for future use.');
    updateOverlayProgress(5, 'Downloading library...');

    const removeFn = await ensureRemoveBackground();
    if (!isCurrent()) return;

    showOverlay('Removing Background...', 'AI is processing your image.<br>This may take a few seconds.');
    updateOverlayProgress(15, 'Preparing image...');

    const imageBlob = await canvasToBlob(renderOriginalCanvas(image), 'image/png');
    if (!isCurrent() || image !== originalImage) return;

    let lastProgress = 20;
    updateOverlayProgress(20, 'Starting AI model...');

    const resultBlob = await removeFn(imageBlob, {
      model: 'medium',
      output: { format: 'image/png' },
      progress: (key, current, total) => {
        if (!isCurrent() || !(total > 0)) return;
        const pct = 20 + (current / total) * 75;
        if (pct <= lastProgress) return;
        lastProgress = pct;
        let statusMsg = 'Processing...';
        if (/fetch|download|load/i.test(key)) {
          statusMsg = 'Downloading model (' + Math.round(pct) + '%)...';
        } else if (/inference|compute/i.test(key)) {
          statusMsg = 'Running AI inference...';
        }
        updateOverlayProgress(pct, statusMsg);
      }
    });

    // A newer run, a new image, or a reset may have happened while the model
    // was working. In that case this result must be discarded entirely.
    if (!isCurrent() || image !== originalImage) return;

    updateOverlayProgress(100, 'Done!');
    await delay(400);
    if (!isCurrent() || image !== originalImage) return;

    const built = await buildMaskFromResult(resultBlob, image, token);
    if (!isCurrent() || image !== originalImage) return;
    if (!built) throw new Error('The AI result could not be read.');

    isProcessing = false;
    hideOverlay();

    hide(actionBar);
    show(resultArea);
    setMode('preview');
    renderPreview();
  } catch (err) {
    if (!isCurrent()) return;   // superseded: a newer action owns the UI now
    isProcessing = false;
    hideOverlay();
    console.error('Background removal failed:', err);
    alert('Background removal failed: ' + (err.message || err));
  }
}

autoRemoveBtn.addEventListener('click', runAutoRemoval);
btnReprocess.addEventListener('click', runAutoRemoval);

// Draws a full-resolution copy of the current image into a fresh canvas.
function renderOriginalCanvas(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d').drawImage(image, 0, 0);
  return canvas;
}

// Derives the alpha-only mask from the AI result and commits it as the new
// editing baseline. Returns false if the run was superseded or decoding failed.
async function buildMaskFromResult(resultBlob, image, token) {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  if (!w || !h) return false;

  const url = URL.createObjectURL(resultBlob);
  try {
    let resultImg;
    try {
      resultImg = await loadImageElement(url);
    } catch (err) {
      if (token === removalToken) console.error('Could not decode AI result:', err);
      return false;
    }

    // Fence check after the async decode, before any state is touched.
    if (token !== removalToken || image !== originalImage) return false;

    const resultCanvas = document.createElement('canvas');
    resultCanvas.width = w;
    resultCanvas.height = h;
    const rCtx = resultCanvas.getContext('2d', { willReadFrequently: true });
    rCtx.drawImage(resultImg, 0, 0, w, h);
    const resultData = rCtx.getImageData(0, 0, w, h);

    // Alpha channel is the mask. RGB is white so the overlay can be tinted
    // without relying on the colour channels.
    const newMask = document.createElement('canvas');
    newMask.width = w;
    newMask.height = h;
    const newMaskCtx = newMask.getContext('2d', { willReadFrequently: true });
    const maskData = newMaskCtx.createImageData(w, h);
    const src = resultData.data;
    const dst = maskData.data;
    for (let i = 0; i < src.length; i += 4) {
      dst[i] = 255;
      dst[i + 1] = 255;
      dst[i + 2] = 255;
      dst[i + 3] = src[i + 3];
    }
    newMaskCtx.putImageData(maskData, 0, 0);

    const newOrig = document.createElement('canvas');
    newOrig.width = w;
    newOrig.height = h;
    newOrig.getContext('2d').drawImage(image, 0, 0, w, h);

    // Atomic commit: swap in the new mask + origin pair together and reset
    // the undo stack so index 0 is this auto-removal result.
    disposeMaskBuffers();
    maskCanvas = newMask;
    maskCtx = newMaskCtx;
    origCanvas = newOrig;
    undoStack = [snapshotMask()];
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Rendering (everything derives from maskCanvas) ─────
function getDisplaySize() {
  const w = origCanvas.width;
  const h = origCanvas.height;
  const maxW = Math.max(1, canvasWrapper.clientWidth || w);
  const maxH = Math.max(1, window.innerHeight * 0.7);
  const scale = Math.min(1, maxW / w, maxH / h);
  return { dw: Math.max(1, Math.round(w * scale)), dh: Math.max(1, Math.round(h * scale)) };
}

function renderPreview() {
  if (!origCanvas || !maskCanvas) {
    clearDisplayCanvases();
    return;
  }

  const { dw, dh } = getDisplaySize();

  if (previewCanvas.width !== dw) previewCanvas.width = dw;
  if (previewCanvas.height !== dh) previewCanvas.height = dh;
  previewCtx.clearRect(0, 0, dw, dh);
  previewCtx.globalCompositeOperation = 'source-over';
  previewCtx.drawImage(origCanvas, 0, 0, dw, dh);

  if (currentMode !== 'refine') {
    // Mask alpha gates the original: the transparent-background preview.
    previewCtx.globalCompositeOperation = 'destination-in';
    previewCtx.drawImage(maskCanvas, 0, 0, dw, dh);
    previewCtx.globalCompositeOperation = 'source-over';
  }

  if (editCanvas.width !== dw) editCanvas.width = dw;
  if (editCanvas.height !== dh) editCanvas.height = dh;

  if (currentMode === 'refine') {
    renderMaskOverlay();
  }
}

// Red tint over the parts of the mask that will be removed.
function renderMaskOverlay() {
  const dw = editCanvas.width;
  const dh = editCanvas.height;
  if (!maskCanvas) {
    editCtx.clearRect(0, 0, dw, dh);
    return;
  }

  editCtx.globalCompositeOperation = 'source-over';
  editCtx.clearRect(0, 0, dw, dh);
  editCtx.drawImage(maskCanvas, 0, 0, dw, dh);

  const overlayData = editCtx.getImageData(0, 0, dw, dh);
  const d = overlayData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < RED_OVERLAY_THRESHOLD) {
      d[i] = 220;
      d[i + 1] = 50;
      d[i + 2] = 50;
      d[i + 3] = 120;
    } else {
      d[i] = 0;
      d[i + 1] = 0;
      d[i + 2] = 0;
      d[i + 3] = 0;
    }
  }
  editCtx.putImageData(overlayData, 0, 0);
}

// Full-resolution composite of the current original + current mask.
function renderCompositeAt(width, height) {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.drawImage(origCanvas, 0, 0, width, height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  return out;
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderPreview();
  });
}

// ── Mode switching ─────────────────────────────────────
function setMode(mode) {
  currentMode = mode;
  [btnPreview, btnRefine].forEach((b) => b.classList.remove('active'));
  if (mode === 'preview') btnPreview.classList.add('active');
  else if (mode === 'refine') btnRefine.classList.add('active');

  if (mode === 'refine') {
    show(refineToolbar);
    show(refineHint);
    editCanvas.style.display = 'block';
    editCanvas.style.cursor = 'none';
  } else {
    hide(refineToolbar);
    hide(refineHint);
    editCanvas.style.display = 'none';
    brushCursor.style.display = 'none';
  }
  renderPreview();
}

btnPreview.addEventListener('click', () => setMode('preview'));
btnRefine.addEventListener('click', () => setMode('refine'));

// ── Manual editing tools ───────────────────────────────
toolBrush.addEventListener('click', () => {
  currentTool = 'brush';
  toolBrush.classList.add('active');
  toolEraser.classList.remove('active');
});
toolEraser.addEventListener('click', () => {
  currentTool = 'eraser';
  toolEraser.classList.add('active');
  toolBrush.classList.remove('active');
});

brushSizeEl.addEventListener('input', () => {
  brushSizeVal.textContent = brushSizeEl.value;
  updateCursorSize();
});
brushSoftEl.addEventListener('input', () => {
  brushSoftVal.textContent = brushSoftEl.value;
});

function updateCursorSize() {
  if (!maskCanvas) {
    brushCursor.style.display = 'none';
    return;
  }
  const sz = clampInt(brushSizeEl.value, 1, 1000, 30);
  const rect = editCanvas.getBoundingClientRect();
  const displayScale = rect.width > 0 ? rect.width / maskCanvas.width : 1;
  const displaySz = Math.max(4, sz * displayScale);
  brushCursor.style.width = displaySz + 'px';
  brushCursor.style.height = displaySz + 'px';
}

// Brush cursor tracking
editCanvas.addEventListener('mouseenter', () => {
  if (currentMode === 'refine') {
    brushCursor.style.display = 'block';
    updateCursorSize();
  }
});
editCanvas.addEventListener('mouseleave', () => {
  brushCursor.style.display = 'none';
  endStroke();
});

// ── Drawing (mutates the mask only) ────────────────────
function toMaskCoords(clientX, clientY) {
  const rect = editCanvas.getBoundingClientRect();
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  return [
    (clientX - rect.left) / rect.width * w,
    (clientY - rect.top) / rect.height * h
  ];
}

function beginStroke(clientX, clientY) {
  if (currentMode !== 'refine' || !maskCanvas || !maskCtx || isProcessing) return false;
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  const rect = editCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  isDrawing = true;
  pushUndoSnapshot();
  [lastX, lastY] = toMaskCoords(clientX, clientY);
  paintOnMask(clientX, clientY);
  return true;
}

function endStroke() {
  if (!isDrawing) return;
  isDrawing = false;
  renderPreview();
}

// Snapshots are taken before each stroke. Index 0 is the auto-removal
// baseline and is never evicted, so undo can always return to it.
function pushUndoSnapshot() {
  const snap = snapshotMask();
  if (!snap) return;
  while (undoStack.length >= MAX_UNDO + 1) {
    undoStack.splice(1, 1);
  }
  undoStack.push(snap);
}

function paintOnMask(clientX, clientY) {
  if (!maskCanvas || !maskCtx || isProcessing) return;

  const [x, y] = toMaskCoords(clientX, clientY);
  const brushSize = clampInt(brushSizeEl.value, 1, 1000, 30);
  const softness = clampInt(brushSoftEl.value, 0, 100, 0) / 100;

  maskCtx.save();
  maskCtx.lineCap = 'round';
  maskCtx.lineJoin = 'round';
  maskCtx.lineWidth = brushSize;

  const blurPx = Math.round(brushSize * softness * 0.3);
  maskCtx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';

  // Brush = add coverage (opaque), eraser = subtract coverage.
  maskCtx.globalCompositeOperation = currentTool === 'brush' ? 'source-over' : 'destination-out';
  maskCtx.strokeStyle = '#ffffff';
  maskCtx.fillStyle = '#ffffff';

  maskCtx.beginPath();
  if (Math.hypot(x - lastX, y - lastY) < 0.5) {
    // A click should leave a dot even without movement.
    maskCtx.arc(x, y, Math.max(0.5, brushSize / 2), 0, Math.PI * 2);
    maskCtx.fill();
  } else {
    maskCtx.moveTo(lastX, lastY);
    maskCtx.lineTo(x, y);
    maskCtx.stroke();
  }
  maskCtx.restore();

  lastX = x;
  lastY = y;

  // Preview (when in preview mode) and the refine overlay both read the
  // mask, so one scheduled repaint keeps them in sync.
  scheduleRender();
}

editCanvas.addEventListener('mousemove', (e) => {
  brushCursor.style.left = e.clientX + 'px';
  brushCursor.style.top = e.clientY + 'px';
  if (isDrawing) paintOnMask(e.clientX, e.clientY);
});

editCanvas.addEventListener('mousedown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  beginStroke(e.clientX, e.clientY);
});

window.addEventListener('mouseup', () => endStroke());

// ── Undo (restores mask snapshots, bottoming out at the AI baseline) ──
function undoMask() {
  if (!maskCanvas || !maskCtx || isProcessing) return;
  if (undoStack.length <= 1) return;
  const snap = undoStack.pop();
  if (!snap) return;
  maskCtx.putImageData(snap, 0, 0);
  renderPreview();
}

toolUndo.addEventListener('click', undoMask);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (currentMode !== 'refine') return;
  if (e.key === '[') {
    brushSizeEl.value = Math.max(5, parseInt(brushSizeEl.value, 10) - 5);
    brushSizeVal.textContent = brushSizeEl.value;
    updateCursorSize();
  } else if (e.key === ']') {
    brushSizeEl.value = Math.min(100, parseInt(brushSizeEl.value, 10) + 5);
    brushSizeVal.textContent = brushSizeEl.value;
    updateCursorSize();
  } else if (e.key === 'b' || e.key === 'B') {
    toolBrush.click();
  } else if (e.key === 'e' || e.key === 'E') {
    toolEraser.click();
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    undoMask();
  }
});

// Touch support
editCanvas.addEventListener('touchstart', (e) => {
  const touch = e.touches[0];
  if (!touch) return;
  if (beginStroke(touch.clientX, touch.clientY)) e.preventDefault();
}, { passive: false });

editCanvas.addEventListener('touchmove', (e) => {
  if (!isDrawing) return;
  const touch = e.touches[0];
  if (!touch) return;
  e.preventDefault();
  paintOnMask(touch.clientX, touch.clientY);
}, { passive: false });

editCanvas.addEventListener('touchend', () => endStroke());
editCanvas.addEventListener('touchcancel', () => endStroke());

// ── Download (always current original + current mask) ──
downloadBtn.addEventListener('click', () => {
  if (!origCanvas || !maskCanvas || isProcessing) return;

  const resultCanvas = renderCompositeAt(origCanvas.width, origCanvas.height);
  resultCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const baseName = (fileNameEl.textContent || 'image').replace(/\.[^.]+$/, '') || 'image';
    a.download = baseName + '-no-bg.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Give the browser time to start the download before releasing the URL.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, 'image/png');
});

// ── Window resize ──────────────────────────────────────
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (resultArea && !resultArea.classList.contains('hidden')) renderPreview();
  }, 200);
});
