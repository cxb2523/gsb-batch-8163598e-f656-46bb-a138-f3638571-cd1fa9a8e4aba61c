// src/core/vexel.js

class Vexel {
    constructor(config = {}) {
        this.container = typeof config.container === 'string'
            ? document.querySelector(config.container)
            : config.container || document.body;
        this.width = Math.max(1, Math.round(config.width || 800));
        this.height = Math.max(1, Math.round(config.height || 600));
        this.zoomEnabled = config.zoom !== false;
        this.panEnabled = config.pan !== false;
        this.gridEnabled = config.grid || false;
        this.snapEnabled = config.snap || false;
        this.snapSize = config.snapSize || 10;
        this.gridSize = config.gridSize || this.snapSize || 20;
        this.gridColor = config.gridColor || 'rgba(128,128,128,0.15)';
        this.gridThickColor = config.gridThickColor || 'rgba(128,128,128,0.3)';
        this.gridThickEvery = config.gridThickEvery || 5;
        this.theme = config.theme || 'dark';
        this.locale = config.locale || 'en';
        this.plugins = [];
        this.layers = [];
        this.shapes = [];
        this.selectedShapes = [];
        this.clipboard = [];
        this.history = { undo: [], redo: [], maxSteps: config.maxHistory || 100 };

        // Single authoritative viewport state. Everything (main canvas,
        // overlay, hit-testing and exports) reads/writes this one object.
        // x/y are CSS-pixel offsets, zoom is a scalar and rotation is radians.
        this.viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
        this.minZoom = config.minZoom || 0.001;
        this.maxZoom = config.maxZoom || 100;

        this.pixelRatio = Vexel.getDevicePixelRatio();
        this.backend = 'canvas2d';
        this.webglRenderer = null;
        this.tool = 'select';
        this.antialias = true;
        this.rulersVisible = config.rulers || false;
        this.rulerSize = config.rulerSize || 20;
        this.selectTool = null;
        this.renderer = null;
        this.canvas = null;
        this.ctx = null;
        this.overlayCanvas = null;
        this.overlayCtx = null;
        this.frameId = null;
        this.dirty = true;
        this.destroyed = false;
        this.autoRender = config.autoRender !== false;
        this._init();
    }

    static getDevicePixelRatio() {
        const ratio = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
        return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    }

    _init() {
        this._createCanvas();
        this._setupRenderer();
        this._attachEvents();
        this._startLoop();
        this._fireEvent('ready', { target: this });
    }

    _createCanvas() {
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';
        this.container.style.width = this.width + 'px';
        this.container.style.height = this.height + 'px';

        this.canvas = document.createElement('canvas');
        this.canvas.dataset.vexelLayer = 'scene';
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.ctx = this.canvas.getContext('2d');

        this.overlayCanvas = document.createElement('canvas');
        this.overlayCanvas.dataset.vexelLayer = 'overlay';
        this.overlayCanvas.style.position = 'absolute';
        this.overlayCanvas.style.top = '0';
        this.overlayCanvas.style.left = '0';
        this.overlayCanvas.style.pointerEvents = 'none';
        this.overlayCtx = this.overlayCanvas.getContext('2d');

        // Sizes both backing stores from the same DPR and resets every
        // transform. This is the only place that decides pixel dimensions.
        this._resizeCanvases();

        this.container.appendChild(this.canvas);
        this.container.appendChild(this.overlayCanvas);
    }

    /**
     * Rebuild both canvas backing stores for the current logical size and
     * devicePixelRatio. Assigning width/height resets the context, so we
     * explicitly re-apply the DPR transform afterwards. This prevents
     * zoom/DPR scaling from accumulating across repeated resizes.
     */
    _resizeCanvases() {
        this.pixelRatio = Vexel.getDevicePixelRatio();
        const pixelWidth = Math.max(1, Math.round(this.width * this.pixelRatio));
        const pixelHeight = Math.max(1, Math.round(this.height * this.pixelRatio));

        for (const canvas of [this.canvas, this.overlayCanvas]) {
            if (!canvas) continue;
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
            canvas.style.width = this.width + 'px';
            canvas.style.height = this.height + 'px';
        }

        for (const ctx of [this.ctx, this.overlayCtx]) {
            if (!ctx) continue;
            ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
        }
    }

    _setupRenderer() {
        // Public aliases used by tools/plugins. They always go through the
        // single shared render path so main canvas and overlay cannot drift.
        this.renderer = {
            clear: () => this.clearCanvas(),
            renderAll: () => this.render(),
            render: () => this.render(),
            setBackend: (backend) => this.setBackend(backend)
        };
    }

    /* ------------------------------------------------------------------ */
    /* Viewport: single source of truth                                    */
    /* ------------------------------------------------------------------ */

    /**
     * Apply the authoritative viewport transform (offset + rotation + zoom)
     * to any 2D context. Main canvas, overlay and exports all use this.
     */
    applyViewTransform(ctx) {
        const vp = this.viewport;
        ctx.translate(vp.x, vp.y);
        ctx.rotate(vp.rotation || 0);
        ctx.scale(vp.zoom, vp.zoom);
        return ctx;
    }

    getViewTransform() {
        return {
            x: this.viewport.x,
            y: this.viewport.y,
            zoom: this.viewport.zoom,
            rotation: this.viewport.rotation,
            pixelRatio: this.pixelRatio
        };
    }

    screenToWorld(screenX, screenY) {
        const vp = this.viewport;
        const cos = Math.cos(vp.rotation || 0);
        const sin = Math.sin(vp.rotation || 0);
        const dx = (screenX - vp.x) / vp.zoom;
        const dy = (screenY - vp.y) / vp.zoom;
        return {
            x: dx * cos + dy * sin,
            y: -dx * sin + dy * cos
        };
    }

    worldToScreen(worldX, worldY) {
        const vp = this.viewport;
        const cos = Math.cos(vp.rotation || 0);
        const sin = Math.sin(vp.rotation || 0);
        return {
            x: vp.x + vp.zoom * (worldX * cos - worldY * sin),
            y: vp.y + vp.zoom * (worldX * sin + worldY * cos)
        };
    }

    clampZoom(zoom) {
        return Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    }

    /**
     * Change zoom while keeping the given screen anchor point fixed under
     * the cursor. Shared by wheel handling and all zoom helpers.
     */
    setZoom(zoom, anchorX, anchorY) {
        const oldZoom = this.viewport.zoom;
        const newZoom = this.clampZoom(zoom);
        if (!Number.isFinite(newZoom) || newZoom === oldZoom) {
            this.viewport.zoom = newZoom;
            this.dirty = true;
            return this.viewport.zoom;
        }

        if (anchorX !== undefined && anchorY !== undefined) {
            const ratio = newZoom / oldZoom;
            this.viewport.x = anchorX - (anchorX - this.viewport.x) * ratio;
            this.viewport.y = anchorY - (anchorY - this.viewport.y) * ratio;
        }

        this.viewport.zoom = newZoom;
        this.dirty = true;
        return newZoom;
    }

    zoomAt(factor, anchorX, anchorY) {
        return this.setZoom(this.viewport.zoom * factor, anchorX, anchorY);
    }

    panBy(dx, dy) {
        this.viewport.x += dx;
        this.viewport.y += dy;
        this.dirty = true;
    }

    setViewport({ x, y, zoom, rotation } = {}) {
        if (x !== undefined) this.viewport.x = x;
        if (y !== undefined) this.viewport.y = y;
        if (zoom !== undefined) this.viewport.zoom = this.clampZoom(zoom);
        if (rotation !== undefined) this.viewport.rotation = rotation;
        this.dirty = true;
    }

    resetView() {
        // Mutate in place so any adapter/tool holding this object stays valid.
        this.viewport.x = 0;
        this.viewport.y = 0;
        this.viewport.zoom = 1;
        this.viewport.rotation = 0;
        this.dirty = true;
    }

    /* ------------------------------------------------------------------ */
    /* Rendering                                                           */
    /* ------------------------------------------------------------------ */

    clearCanvas() {
        const pixelWidth = this.canvas ? this.canvas.width : 0;
        const pixelHeight = this.canvas ? this.canvas.height : 0;
        if (this.ctx) {
            this.ctx.setTransform(1, 0, 0, 1, 0, 0);
            this.ctx.clearRect(0, 0, pixelWidth, pixelHeight);
            this.ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
        }
        if (this.overlayCtx) {
            this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
            this.overlayCtx.clearRect(0, 0, pixelWidth, pixelHeight);
            this.overlayCtx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
        }
    }

    render() {
        if (this.destroyed) return;

        this.clearCanvas();

        const ctx = this.ctx;

        if (this.gridEnabled) this._drawGrid(ctx);

        if (this.backend === 'webgl' && this.webglRenderer) {
            this._renderWebGLScene();
        } else {
            this._renderCanvasShapes(ctx);
        }

        // Rulers sit on top of the artwork (they are fixed UI chrome).
        if (this.rulersVisible) this._drawRulers(ctx);

        this.renderSelectionOverlay(this.overlayCtx);

        this.dirty = false;
        this._fireEvent('render', { viewport: this.getViewTransform() });
    }

    _drawShapes2D(ctx, shapes = this.shapes) {
        for (const shape of shapes) {
            if (shape && shape.visible !== false) shape.draw(ctx);
        }
    }

    _renderCanvasShapes(ctx) {
        ctx.save();
        if (this.antialias !== false) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
        }
        this._applyViewTransform(ctx, this.viewport);
        this._drawShapes2D(ctx);
        ctx.restore();
    }

    _renderWebGLScene() {
        try {
            const renderer = this.webglRenderer;
            renderer.begin();
            const supported = [];
            const unsupported = [];
            for (const shape of this.shapes) {
                if (!shape || shape.visible === false) continue;
                if (renderer.supportsShape && renderer.supportsShape(shape)) {
                    supported.push(shape);
                } else {
                    unsupported.push(shape);
                }
            }
            for (const shape of supported) renderer.drawShape(shape);
            renderer.end();

            if (unsupported.length === 0) {
                // Composite the WebGL canvas into the main 2D canvas so the
                // overlay/grid stay in one shared coordinate space.
                this.ctx.drawImage(renderer.canvas, 0, 0, this.width, this.height);
            } else {
                // Mixed scene: fall back to Canvas2D for everything so z-order
                // stays correct and no shape silently disappears.
                this._renderCanvasShapes(this.ctx);
            }
        } catch (error) {
            console.warn('WebGL render failed, falling back to Canvas2D:', error);
            this._fallbackToCanvas2D();
            // The current frame was already cleared; redraw it via Canvas2D
            // now so the user never sees a blank canvas for one frame.
            this._renderCanvasShapes(this.ctx);
        }
    }

    _drawGrid(ctx) {
        this._drawGridOn(ctx, this.viewport);
    }

    _drawGridOn(ctx, viewport) {
        const zoom = viewport.zoom;
        const gridSize = this.gridSize;
        if (!gridSize || gridSize <= 0 || zoom <= 0) return;

        const worldBounds = this._visibleWorldBoundsFor(viewport);
        const startX = Math.floor(worldBounds.x / gridSize) * gridSize;
        const startY = Math.floor(worldBounds.y / gridSize) * gridSize;
        const endX = Math.ceil((worldBounds.x + worldBounds.width) / gridSize) * gridSize;
        const endY = Math.ceil((worldBounds.y + worldBounds.height) / gridSize) * gridSize;

        ctx.save();
        this._applyViewTransform(ctx, viewport);
        ctx.strokeStyle = this.gridColor;
        ctx.lineWidth = 0.5 / zoom;

        ctx.beginPath();
        for (let x = startX; x <= endX; x += gridSize) {
            ctx.moveTo(x, startY);
            ctx.lineTo(x, endY);
        }
        for (let y = startY; y <= endY; y += gridSize) {
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
        }
        ctx.stroke();

        if (this.gridThickEvery > 1) {
            ctx.strokeStyle = this.gridThickColor;
            ctx.lineWidth = 1 / zoom;
            ctx.beginPath();
            for (let x = startX; x <= endX; x += gridSize * this.gridThickEvery) {
                ctx.moveTo(x, startY);
                ctx.lineTo(x, endY);
            }
            for (let y = startY; y <= endY; y += gridSize * this.gridThickEvery) {
                ctx.moveTo(startX, y);
                ctx.lineTo(endX, y);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    _applyViewTransform(ctx, vp) {
        ctx.translate(vp.x, vp.y);
        ctx.rotate(vp.rotation || 0);
        ctx.scale(vp.zoom, vp.zoom);
    }

    _visibleWorldBoundsFor(vp) {
        const corners = [
            this._screenToWorldFor(vp, 0, 0),
            this._screenToWorldFor(vp, this.width, 0),
            this._screenToWorldFor(vp, this.width, this.height),
            this._screenToWorldFor(vp, 0, this.height)
        ];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of corners) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    _screenToWorldFor(vp, screenX, screenY) {
        const cos = Math.cos(vp.rotation || 0);
        const sin = Math.sin(vp.rotation || 0);
        const dx = (screenX - vp.x) / vp.zoom;
        const dy = (screenY - vp.y) / vp.zoom;
        return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
    }

    _drawRulers(ctx) {
        const rulerSize = this.rulerSize || 20;
        ctx.save();
        ctx.fillStyle = '#f5f5f4';
        ctx.fillRect(0, 0, this.width, rulerSize);
        ctx.fillRect(0, 0, rulerSize, this.height);
        ctx.strokeStyle = '#d6d3d1';
        ctx.lineWidth = 1;
        ctx.strokeRect(0, 0, this.width, rulerSize);
        ctx.strokeRect(0, 0, rulerSize, this.height);

        ctx.fillStyle = '#78716c';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.textBaseline = 'middle';

        const gridSize = this.gridSize || 20;
        const step = gridSize * this.viewport.zoom;
        if (step < 1) {
            ctx.restore();
            return;
        }
        const startX = this.viewport.x % step;
        const startY = this.viewport.y % step;

        for (let x = startX; x < this.width; x += step) {
            if (x < rulerSize) continue;
            const world = this.screenToWorld(x, 0);
            ctx.fillText(Math.round(world.x / gridSize) * gridSize, x + 2, 12);
        }
        for (let y = startY; y < this.height; y += step) {
            if (y < rulerSize) continue;
            const world = this.screenToWorld(0, y);
            ctx.save();
            ctx.translate(12, y + 2);
            ctx.rotate(-Math.PI / 2);
            ctx.fillText(Math.round(world.y / gridSize) * gridSize, 0, 0);
            ctx.restore();
        }
        ctx.restore();
    }

    _drawSelectionHandles() {
        // Kept for backwards compatibility; delegates to the shared overlay.
        this.renderSelectionOverlay(this.overlayCtx);
    }

    renderSelectionOverlay(ctx) {
        if (!ctx) return;
        const selected = this.selectedShapes;
        if (!selected || selected.length === 0) {
            if (this.selectTool && this.selectTool.marquee) {
                this.selectTool.drawMarquee(ctx);
            }
            return;
        }

        const zoom = this.viewport.zoom;
        ctx.save();
        this._applyViewTransform(ctx, this.viewport);

        for (const shape of selected) {
            const bounds = shape.getBounds();
            const handleSize = 7 / zoom;

            ctx.strokeStyle = '#4A90D9';
            ctx.lineWidth = 1.5 / zoom;
            ctx.setLineDash([4 / zoom, 4 / zoom]);
            ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
            ctx.setLineDash([]);

            const handles = [
                { x: bounds.x, y: bounds.y },
                { x: bounds.x + bounds.width, y: bounds.y },
                { x: bounds.x, y: bounds.y + bounds.height },
                { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
                { x: bounds.x + bounds.width / 2, y: bounds.y },
                { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height },
                { x: bounds.x, y: bounds.y + bounds.height / 2 },
                { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 }
            ];

            for (const h of handles) {
                this._drawHandle(ctx, h.x, h.y, handleSize / 2);
            }
        }
        ctx.restore();

        if (this.selectTool && this.selectTool.marquee) {
            this.selectTool.drawMarquee(ctx);
        }
        if (this.selectTool && selected.length === 1) {
            this.selectTool.drawRotationHandle(ctx);
        }
    }

    _drawHandle(ctx, x, y, half) {
        const zoom = this.viewport.zoom;
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#4A90D9';
        ctx.lineWidth = 1.5 / zoom;
        ctx.fillRect(x - half, y - half, half * 2, half * 2);
        ctx.strokeRect(x - half, y - half, half * 2, half * 2);
    }

    getVisibleWorldBounds() {
        return this._visibleWorldBoundsFor(this.viewport);
    }

    /* ------------------------------------------------------------------ */
    /* Backends                                                            */
    /* ------------------------------------------------------------------ */

    setBackend(backend) {
        const aliases = { '2d': 'canvas2d', canvas: 'canvas2d', gpu: 'webgl' };
        backend = aliases[backend] || backend;

        if (backend === this.backend && backend !== 'webgl') {
            return this.backend;
        }

        if (backend === 'canvas2d' || backend === undefined) {
            this._destroyWebGL();
            this.backend = 'canvas2d';
            this.dirty = true;
            return this.backend;
        }

        if (backend !== 'webgl') {
            console.warn(`Backend "${backend}" not supported. Using canvas2d.`);
            this._destroyWebGL();
            this.backend = 'canvas2d';
            this.dirty = true;
            return this.backend;
        }

        const ok = this._initWebGL();
        if (!ok) {
            this._destroyWebGL();
            this.backend = 'canvas2d';
            this.dirty = true;
            return this.backend;
        }

        this.backend = 'webgl';
        this.dirty = true;
        return this.backend;
    }

    _initWebGL() {
        if (typeof window === 'undefined') return false;
        const WebGLRenderer = window.VexelWebGLRenderer;
        if (typeof WebGLRenderer !== 'function') return false;
        if (this.webglRenderer) return true;

        let renderer = null;
        try {
            renderer = new WebGLRenderer(this);
            const ok = renderer.init({
                width: this.width,
                height: this.height,
                pixelRatio: this.pixelRatio
            });
            if (!ok) {
                if (renderer.destroy) renderer.destroy();
                return false;
            }
            this.webglRenderer = renderer;
            return true;
        } catch (error) {
            console.warn('WebGL initialization failed:', error);
            if (renderer && renderer.destroy) renderer.destroy();
            this.webglRenderer = null;
            return false;
        }
    }

    _destroyWebGL() {
        if (this.webglRenderer) {
            try {
                this.webglRenderer.destroy();
            } catch (error) {
                console.warn('Error destroying WebGL renderer:', error);
            }
            this.webglRenderer = null;
        }
    }

    _fallbackToCanvas2D() {
        this._destroyWebGL();
        this.backend = 'canvas2d';
        this.dirty = true;
    }

    _startLoop() {
        if (!this.autoRender) return;
        const loop = () => {
            if (this.destroyed) return;
            if (this.dirty) this.render();
            this.frameId = requestAnimationFrame(loop);
        };
        this.frameId = requestAnimationFrame(loop);
    }

    _attachEvents() {
        let isPanning = false;
        let panStart = { x: 0, y: 0 };
        let panViewportStart = { x: 0, y: 0 };

        this._wheelHandler = (e) => {
            if (!this.zoomEnabled) return;
            e.preventDefault();
            const rect = this.container.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const delta = e.deltaY > 0 ? 0.9 : 1.1;
            this.setZoom(this.viewport.zoom * delta, mouseX, mouseY);
        };
        this.container.addEventListener('wheel', this._wheelHandler, { passive: false });

        this._mouseDownHandler = (e) => {
            if (e.button === 1 || (e.button === 0 && e.altKey)) {
                if (!this.panEnabled) return;
                isPanning = true;
                panStart = { x: e.clientX, y: e.clientY };
                panViewportStart = { x: this.viewport.x, y: this.viewport.y };
                this.container.style.cursor = 'grabbing';
                return;
            }
            if (e.button === 0) {
                this._handleMouseDown(e);
            }
        };
        this.container.addEventListener('mousedown', this._mouseDownHandler);

        this._mouseMoveHandler = (e) => {
            if (isPanning) {
                this.viewport.x = panViewportStart.x + (e.clientX - panStart.x);
                this.viewport.y = panViewportStart.y + (e.clientY - panStart.y);
                this.dirty = true;
            }
        };
        window.addEventListener('mousemove', this._mouseMoveHandler);

        this._mouseUpHandler = () => {
            if (isPanning) {
                isPanning = false;
                this.container.style.cursor = 'default';
            }
        };
        window.addEventListener('mouseup', this._mouseUpHandler);
    }

    _handleMouseDown(e) {
        const rect = this.container.getBoundingClientRect();
        const point = this.screenToWorld(
            e.clientX - rect.left,
            e.clientY - rect.top
        );
        this._fireEvent('mousedown', { x: point.x, y: point.y, originalEvent: e });
    }

    _fireEvent(name, data) {
        const event = new CustomEvent(`vexel:${name}`, { detail: data });
        this.container.dispatchEvent(event);
    }

    on(event, callback) {
        this.container.addEventListener(`vexel:${event}`, (e) => callback(e.detail));
    }

    off(event, callback) {
        this.container.removeEventListener(`vexel:${event}`, callback);
    }

    rectangle(x, y, width, height, options = {}) {
        const shape = new VexelRectangle(x, y, width, height, options);
        this.shapes.push(shape);
        this.dirty = true;
        this._pushHistory({ type: 'add', shape });
        return shape;
    }

    ellipse(x, y, radiusX, radiusY, options = {}) {
        const shape = new VexelEllipse(x, y, radiusX, radiusY, options);
        this.shapes.push(shape);
        this.dirty = true;
        this._pushHistory({ type: 'add', shape });
        return shape;
    }

    polygon(x, y, sides, radius, options = {}) {
        const shape = new VexelPolygon(x, y, sides, radius, options);
        this.shapes.push(shape);
        this.dirty = true;
        this._pushHistory({ type: 'add', shape });
        return shape;
    }

    line(x1, y1, x2, y2, options = {}) {
        const shape = new VexelLine(x1, y1, x2, y2, options);
        this.shapes.push(shape);
        this.dirty = true;
        this._pushHistory({ type: 'add', shape });
        return shape;
    }

    path(points, options = {}) {
        const shape = new VexelPath(points, options);
        this.shapes.push(shape);
        this.dirty = true;
        this._pushHistory({ type: 'add', shape });
        return shape;
    }

    text(x, y, content, options = {}) {
        const shape = new VexelText(x, y, content, options);
        this.shapes.push(shape);
        this.dirty = true;
        this._pushHistory({ type: 'add', shape });
        return shape;
    }

    image(x, y, src, options = {}) {
        const shape = new VexelImage(x, y, src, options);
        this.shapes.push(shape);
        this.dirty = true;
        this._pushHistory({ type: 'add', shape });
        return shape;
    }

    group(shapes, options = {}) {
        const group = new VexelGroup(shapes, options);
        this.shapes.push(group);
        this.dirty = true;
        this._pushHistory({ type: 'add', shape: group });
        return group;
    }

    remove(shape) {
        const index = this.shapes.indexOf(shape);
        if (index > -1) {
            this.shapes.splice(index, 1);
            this.dirty = true;
            this._pushHistory({ type: 'remove', shape, index });
        }
    }

    clear() {
        this.shapes = [];
        this.selectedShapes = [];
        this.dirty = true;
        this._pushHistory({ type: 'clear', shapes: [...this.shapes] });
    }

    select(shape) {
        if (!this.selectedShapes.includes(shape)) {
            this.selectedShapes.push(shape);
            this.dirty = true;
        }
    }

    deselect(shape) {
        const index = this.selectedShapes.indexOf(shape);
        if (index > -1) {
            this.selectedShapes.splice(index, 1);
            this.dirty = true;
        }
    }

    selectAll() {
        this.selectedShapes = [...this.shapes];
        this.dirty = true;
    }

    deselectAll() {
        this.selectedShapes = [];
        this.dirty = true;
    }

    deleteSelected() {
        for (const shape of [...this.selectedShapes]) {
            this.remove(shape);
        }
        this.selectedShapes = [];
        this.dirty = true;
    }

    zoomIn(factor = 1.1) {
        this.setZoom(this.viewport.zoom * factor, this.width / 2, this.height / 2);
    }

    zoomOut(factor = 0.9) {
        this.setZoom(this.viewport.zoom * factor, this.width / 2, this.height / 2);
    }

    zoomToFit(padding = 50) {
        if (this.shapes.length === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const shape of this.shapes) {
            const b = shape.getBounds();
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
        }
        const contentWidth = maxX - minX + padding * 2;
        const contentHeight = maxY - minY + padding * 2;
        const zoomX = this.width / contentWidth;
        const zoomY = this.height / contentHeight;
        this.viewport.zoom = this.clampZoom(Math.min(zoomX, zoomY));
        this.viewport.x = (this.width - contentWidth * this.viewport.zoom) / 2 - minX * this.viewport.zoom + padding * this.viewport.zoom;
        this.viewport.y = (this.height - contentHeight * this.viewport.zoom) / 2 - minY * this.viewport.zoom + padding * this.viewport.zoom;
        // Fit assumes an unrotated view so the content is fully visible.
        this.viewport.rotation = 0;
        this.dirty = true;
    }

    undo() {
        if (this.history.undo.length === 0) return;
        const action = this.history.undo.pop();
        this.history.redo.push(action);
        this._applyUndo(action);
        this.dirty = true;
    }

    redo() {
        if (this.history.redo.length === 0) return;
        const action = this.history.redo.pop();
        this.history.undo.push(action);
        this._applyRedo(action);
        this.dirty = true;
    }

    _pushHistory(action) {
        this.history.undo.push(action);
        if (this.history.undo.length > this.history.maxSteps) {
            this.history.undo.shift();
        }
        this.history.redo = [];
    }

    _applyUndo(action) {
        if (action.type === 'add') {
            const index = this.shapes.indexOf(action.shape);
            if (index > -1) this.shapes.splice(index, 1);
        } else if (action.type === 'remove') {
            this.shapes.splice(action.index, 0, action.shape);
        } else if (action.type === 'clear') {
            this.shapes = [...action.shapes];
        }
    }

    _applyRedo(action) {
        if (action.type === 'add') {
            this.shapes.push(action.shape);
        } else if (action.type === 'remove') {
            const index = this.shapes.indexOf(action.shape);
            if (index > -1) this.shapes.splice(index, 1);
        } else if (action.type === 'clear') {
            this.shapes = [];
        }
    }

    save() {
        return {
            version: '1.0.0',
            viewport: { ...this.viewport },
            shapes: this.shapes.map(s => s.serialize()),
            layers: this.layers.map(l => l.serialize()),
            exportedAt: new Date().toISOString()
        };
    }

    load(data) {
        if (!data || !data.shapes) return;
        this.clear();
        const vp = data.viewport || {};
        this.viewport.x = vp.x || 0;
        this.viewport.y = vp.y || 0;
        this.viewport.zoom = this.clampZoom(vp.zoom || 1);
        this.viewport.rotation = vp.rotation || 0;
        for (const shapeData of data.shapes) {
            const shape = this._deserializeShape(shapeData);
            if (shape) this.shapes.push(shape);
        }
        this.dirty = true;
    }

    _deserializeShape(data) {
        const constructors = {
            rectangle: VexelRectangle,
            ellipse: VexelEllipse,
            polygon: VexelPolygon,
            line: VexelLine,
            path: VexelPath,
            text: VexelText,
            image: VexelImage,
            group: VexelGroup
        };
        const Ctor = constructors[data.type];
        if (!Ctor) return null;
        return Ctor.deserialize(data);
    }

    exportJSON() {
        return JSON.stringify(this.save(), null, 2);
    }

    exportSVG() {
        let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">`;
        for (const shape of this.shapes) {
            svg += shape.toSVG();
        }
        svg += '</svg>';
        return svg;
    }

    /**
     * Render the current viewport to an offscreen canvas. This is
     * independent of whether the on-screen canvas has painted a frame yet,
     * so it always reflects the authoritative viewport state.
     */
    renderToCanvas(options = {}) {
        const {
            scale = 1,
            background = '#ffffff',
            viewport = this.viewport,
            includeGrid = this.gridEnabled,
            width = this.width,
            height = this.height
        } = options;

        const canvas = document.createElement('canvas');
        const pixelRatio = Math.max(0.0001, scale);
        canvas.width = Math.max(1, Math.round(width * pixelRatio));
        canvas.height = Math.max(1, Math.round(height * pixelRatio));
        const ctx = canvas.getContext('2d');
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

        if (background && background !== 'transparent') {
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, width, height);
        }

        if (includeGrid) {
            this._drawGridOn(ctx, viewport);
        }

        ctx.save();
        ctx.translate(viewport.x, viewport.y);
        ctx.rotate(viewport.rotation || 0);
        ctx.scale(viewport.zoom, viewport.zoom);
        this._drawShapes2D(ctx);
        ctx.restore();

        return canvas;
    }

    exportPNG(scale = 1) {
        return new Promise((resolve, reject) => {
            try {
                const canvas = this.renderToCanvas({ scale });
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Failed to encode PNG'));
                }, 'image/png');
            } catch (error) {
                reject(error);
            }
        });
    }

    addPlugin(plugin) {
        this.plugins.push(plugin);
        if (plugin.install) plugin.install(this);
    }

    removePlugin(plugin) {
        const index = this.plugins.indexOf(plugin);
        if (index > -1) {
            if (plugin.uninstall) plugin.uninstall(this);
            this.plugins.splice(index, 1);
        }
    }

    /**
     * Resize the logical drawing surface. The viewport's zoom/offset/
     * rotation are kept, but both canvas backing stores are rebuilt at the
     * current devicePixelRatio with transforms fully reset, so repeated
     * resizes never accumulate scale.
     */
    resize(width, height) {
        const w = Math.max(1, Math.round(Number(width) || 1));
        const h = Math.max(1, Math.round(Number(height) || 1));
        if (w === this.width && h === this.height && this.pixelRatio === Vexel.getDevicePixelRatio()) {
            return;
        }

        this.width = w;
        this.height = h;
        this.container.style.width = w + 'px';
        this.container.style.height = h + 'px';

        this._resizeCanvases();

        if (this.webglRenderer) {
            this.webglRenderer.resize(w, h, this.pixelRatio);
        }

        this.dirty = true;
    }

    destroy() {
        this.destroyed = true;
        cancelAnimationFrame(this.frameId);
        this.frameId = null;

        this._destroyWebGL();

        if (this._wheelHandler) {
            this.container.removeEventListener('wheel', this._wheelHandler);
        }
        if (this._mouseDownHandler) {
            this.container.removeEventListener('mousedown', this._mouseDownHandler);
        }
        if (this._mouseMoveHandler && typeof window !== 'undefined') {
            window.removeEventListener('mousemove', this._mouseMoveHandler);
        }
        if (this._mouseUpHandler && typeof window !== 'undefined') {
            window.removeEventListener('mouseup', this._mouseUpHandler);
        }

        for (const canvas of [this.canvas, this.overlayCanvas]) {
            if (canvas && canvas.parentNode === this.container) {
                this.container.removeChild(canvas);
            }
        }

        this.canvas = null;
        this.overlayCanvas = null;
        this.ctx = null;
        this.overlayCtx = null;
        this.shapes = [];
        this.layers = [];
        this.plugins = [];
        this.history = { undo: [], redo: [], maxSteps: 100 };
    }
}

class VexelRectangle {
    constructor(x, y, width, height, options = {}) {
        this.type = 'rectangle';
        this.x = x;
        this.y = y;
        this.width = width;
        this.height = height;
        this.fill = options.fill || 'transparent';
        this.stroke = options.stroke || 'none';
        this.strokeWidth = options.strokeWidth || 1;
        this.cornerRadius = options.cornerRadius || 0;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.scaleX = options.scaleX || 1;
        this.scaleY = options.scaleY || 1;
        this.id = options.id || `rect_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.scale(this.scaleX, this.scaleY);
        const x = -this.width / 2;
        const y = -this.height / 2;
        if (this.cornerRadius > 0) {
            ctx.beginPath();
            ctx.roundRect(x, y, this.width, this.height, this.cornerRadius);
        } else {
            ctx.beginPath();
            ctx.rect(x, y, this.width, this.height);
        }
        if (this.fill !== 'transparent') {
            ctx.fillStyle = this.fill;
            ctx.fill();
        }
        if (this.stroke !== 'none') {
            ctx.strokeStyle = this.stroke;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
        ctx.restore();
    }

    getBounds() {
        return {
            x: this.x,
            y: this.y,
            width: this.width * this.scaleX,
            height: this.height * this.scaleY
        };
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            width: this.width, height: this.height,
            fill: this.fill, stroke: this.stroke,
            strokeWidth: this.strokeWidth, cornerRadius: this.cornerRadius,
            opacity: this.opacity, visible: this.visible,
            rotation: this.rotation, scaleX: this.scaleX, scaleY: this.scaleY,
            id: this.id
        };
    }

    static deserialize(data) {
        return new VexelRectangle(data.x, data.y, data.width, data.height, data);
    }

    toSVG() {
        return `<rect x="${this.x}" y="${this.y}" width="${this.width}" height="${this.height}" fill="${this.fill}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" rx="${this.cornerRadius}" opacity="${this.opacity}" transform="rotate(${this.rotation} ${this.x + this.width / 2} ${this.y + this.height / 2})"/>`;
    }
}

class VexelEllipse {
    constructor(x, y, radiusX, radiusY, options = {}) {
        this.type = 'ellipse';
        this.x = x;
        this.y = y;
        this.radiusX = radiusX;
        this.radiusY = radiusY;
        this.fill = options.fill || 'transparent';
        this.stroke = options.stroke || 'none';
        this.strokeWidth = options.strokeWidth || 1;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.id = options.id || `ellipse_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.beginPath();
        ctx.ellipse(0, 0, this.radiusX, this.radiusY, 0, 0, Math.PI * 2);
        if (this.fill !== 'transparent') {
            ctx.fillStyle = this.fill;
            ctx.fill();
        }
        if (this.stroke !== 'none') {
            ctx.strokeStyle = this.stroke;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
        ctx.restore();
    }

    getBounds() {
        return {
            x: this.x - this.radiusX,
            y: this.y - this.radiusY,
            width: this.radiusX * 2,
            height: this.radiusY * 2
        };
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            radiusX: this.radiusX, radiusY: this.radiusY,
            fill: this.fill, stroke: this.stroke,
            strokeWidth: this.strokeWidth, opacity: this.opacity,
            visible: this.visible, rotation: this.rotation,
            id: this.id
        };
    }

    static deserialize(data) {
        return new VexelEllipse(data.x, data.y, data.radiusX, data.radiusY, data);
    }

    toSVG() {
        return `<ellipse cx="${this.x}" cy="${this.y}" rx="${this.radiusX}" ry="${this.radiusY}" fill="${this.fill}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" opacity="${this.opacity}" transform="rotate(${this.rotation} ${this.x} ${this.y})"/>`;
    }
}

class VexelPolygon {
    constructor(x, y, sides, radius, options = {}) {
        this.type = 'polygon';
        this.x = x;
        this.y = y;
        this.sides = sides;
        this.radius = radius;
        this.fill = options.fill || 'transparent';
        this.stroke = options.stroke || 'none';
        this.strokeWidth = options.strokeWidth || 1;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.id = options.id || `polygon_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.beginPath();
        for (let i = 0; i < this.sides; i++) {
            const angle = (i * 2 * Math.PI) / this.sides - Math.PI / 2;
            const px = Math.cos(angle) * this.radius;
            const py = Math.sin(angle) * this.radius;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        if (this.fill !== 'transparent') {
            ctx.fillStyle = this.fill;
            ctx.fill();
        }
        if (this.stroke !== 'none') {
            ctx.strokeStyle = this.stroke;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
        ctx.restore();
    }

    getBounds() {
        return {
            x: this.x - this.radius,
            y: this.y - this.radius,
            width: this.radius * 2,
            height: this.radius * 2
        };
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            sides: this.sides, radius: this.radius,
            fill: this.fill, stroke: this.stroke,
            strokeWidth: this.strokeWidth, opacity: this.opacity,
            visible: this.visible, rotation: this.rotation,
            id: this.id
        };
    }

    static deserialize(data) {
        return new VexelPolygon(data.x, data.y, data.sides, data.radius, data);
    }

    toSVG() {
        let points = '';
        for (let i = 0; i < this.sides; i++) {
            const angle = (i * 2 * Math.PI) / this.sides - Math.PI / 2;
            points += `${this.x + Math.cos(angle) * this.radius},${this.y + Math.sin(angle) * this.radius} `;
        }
        return `<polygon points="${points.trim()}" fill="${this.fill}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" opacity="${this.opacity}" transform="rotate(${this.rotation} ${this.x} ${this.y})"/>`;
    }
}

class VexelLine {
    constructor(x1, y1, x2, y2, options = {}) {
        this.type = 'line';
        this.x1 = x1;
        this.y1 = y1;
        this.x2 = x2;
        this.y2 = y2;
        this.stroke = options.stroke || '#000000';
        this.strokeWidth = options.strokeWidth || 1;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.lineCap = options.lineCap || 'butt';
        this.lineDash = options.lineDash || [];
        this.id = options.id || `line_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.strokeStyle = this.stroke;
        ctx.lineWidth = this.strokeWidth;
        ctx.lineCap = this.lineCap;
        ctx.setLineDash(this.lineDash);
        ctx.beginPath();
        ctx.moveTo(this.x1, this.y1);
        ctx.lineTo(this.x2, this.y2);
        ctx.stroke();
        ctx.restore();
    }

    getBounds() {
        return {
            x: Math.min(this.x1, this.x2),
            y: Math.min(this.y1, this.y2),
            width: Math.abs(this.x2 - this.x1),
            height: Math.abs(this.y2 - this.y1)
        };
    }

    serialize() {
        return {
            type: this.type,
            x1: this.x1, y1: this.y1,
            x2: this.x2, y2: this.y2,
            stroke: this.stroke, strokeWidth: this.strokeWidth,
            opacity: this.opacity, visible: this.visible,
            lineCap: this.lineCap, lineDash: this.lineDash,
            id: this.id
        };
    }

    static deserialize(data) {
        return new VexelLine(data.x1, data.y1, data.x2, data.y2, data);
    }

    toSVG() {
        return `<line x1="${this.x1}" y1="${this.y1}" x2="${this.x2}" y2="${this.y2}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" opacity="${this.opacity}"/>`;
    }
}

class VexelPath {
    constructor(points, options = {}) {
        this.type = 'path';
        this.points = points;
        this.closed = options.closed || false;
        this.fill = options.fill || 'transparent';
        this.stroke = options.stroke || '#000000';
        this.strokeWidth = options.strokeWidth || 1;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.id = options.id || `path_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    draw(ctx) {
        if (!this.visible || this.points.length < 2) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.beginPath();
        ctx.moveTo(this.points[0].x, this.points[0].y);
        for (let i = 1; i < this.points.length; i++) {
            ctx.lineTo(this.points[i].x, this.points[i].y);
        }
        if (this.closed) ctx.closePath();
        if (this.fill !== 'transparent') {
            ctx.fillStyle = this.fill;
            ctx.fill();
        }
        if (this.stroke !== 'none') {
            ctx.strokeStyle = this.stroke;
            ctx.lineWidth = this.strokeWidth;
            ctx.stroke();
        }
        ctx.restore();
    }

    getBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of this.points) {
            minX = Math.min(minX, p.x);
            minY = Math.min(minY, p.y);
            maxX = Math.max(maxX, p.x);
            maxY = Math.max(maxY, p.y);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    serialize() {
        return {
            type: this.type,
            points: this.points,
            closed: this.closed,
            fill: this.fill, stroke: this.stroke,
            strokeWidth: this.strokeWidth, opacity: this.opacity,
            visible: this.visible, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelPath(data.points, data);
    }

    toSVG() {
        let d = `M ${this.points[0].x} ${this.points[0].y}`;
        for (let i = 1; i < this.points.length; i++) {
            d += ` L ${this.points[i].x} ${this.points[i].y}`;
        }
        if (this.closed) d += ' Z';
        return `<path d="${d}" fill="${this.fill}" stroke="${this.stroke}" stroke-width="${this.strokeWidth}" opacity="${this.opacity}"/>`;
    }
}

class VexelText {
    constructor(x, y, content, options = {}) {
        this.type = 'text';
        this.x = x;
        this.y = y;
        this.content = content;
        this.fontSize = options.fontSize || 16;
        this.fontFamily = options.fontFamily || 'sans-serif';
        this.fontWeight = options.fontWeight || 'normal';
        this.fontStyle = options.fontStyle || 'normal';
        this.fill = options.fill || '#000000';
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.align = options.align || 'left';
        this.id = options.id || `text_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.font = `${this.fontStyle} ${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
        ctx.fillStyle = this.fill;
        ctx.textAlign = this.align;
        ctx.textBaseline = 'top';
        const lines = this.content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], 0, i * this.fontSize * 1.4);
        }
        ctx.restore();
    }

    getBounds() {
        return {
            x: this.x,
            y: this.y,
            width: this.content.length * this.fontSize * 0.6,
            height: this.fontSize * 1.4 * this.content.split('\n').length
        };
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            content: this.content,
            fontSize: this.fontSize, fontFamily: this.fontFamily,
            fontWeight: this.fontWeight, fontStyle: this.fontStyle,
            fill: this.fill, opacity: this.opacity,
            visible: this.visible, rotation: this.rotation,
            align: this.align, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelText(data.x, data.y, data.content, data);
    }

    toSVG() {
        return `<text x="${this.x}" y="${this.y}" font-size="${this.fontSize}" font-family="${this.fontFamily}" font-weight="${this.fontWeight}" font-style="${this.fontStyle}" fill="${this.fill}" opacity="${this.opacity}" text-anchor="${this.align}" transform="rotate(${this.rotation} ${this.x} ${this.y})">${this.content}</text>`;
    }
}

class VexelImage {
    constructor(x, y, src, options = {}) {
        this.type = 'image';
        this.x = x;
        this.y = y;
        this.src = src;
        this.width = options.width || 100;
        this.height = options.height || 100;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.visible = options.visible !== false;
        this.rotation = options.rotation || 0;
        this.loaded = false;
        this.img = new Image();
        this.img.src = src;
        this.img.onload = () => { this.loaded = true; };
        this.id = options.id || `image_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    draw(ctx) {
        if (!this.visible || !this.loaded) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x + this.width / 2, this.y + this.height / 2);
        ctx.rotate((this.rotation * Math.PI) / 180);
        ctx.drawImage(this.img, -this.width / 2, -this.height / 2, this.width, this.height);
        ctx.restore();
    }

    getBounds() {
        return { x: this.x, y: this.y, width: this.width, height: this.height };
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            src: this.src, width: this.width, height: this.height,
            opacity: this.opacity, visible: this.visible,
            rotation: this.rotation, id: this.id
        };
    }

    static deserialize(data) {
        return new VexelImage(data.x, data.y, data.src, data);
    }

    toSVG() {
        return `<image href="${this.src}" x="${this.x}" y="${this.y}" width="${this.width}" height="${this.height}" opacity="${this.opacity}" transform="rotate(${this.rotation} ${this.x + this.width / 2} ${this.y + this.height / 2})"/>`;
    }
}

class VexelGroup {
    constructor(shapes = [], options = {}) {
        this.type = 'group';
        this.shapes = shapes;
        this.x = options.x || 0;
        this.y = options.y || 0;
        this.visible = options.visible !== false;
        this.opacity = options.opacity !== undefined ? options.opacity : 1;
        this.rotation = options.rotation || 0;
        this.id = options.id || `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    draw(ctx) {
        if (!this.visible) return;
        ctx.save();
        ctx.globalAlpha = this.opacity;
        ctx.translate(this.x, this.y);
        ctx.rotate((this.rotation * Math.PI) / 180);
        for (const shape of this.shapes) {
            shape.draw(ctx);
        }
        ctx.restore();
    }

    add(shape) {
        this.shapes.push(shape);
    }

    remove(shape) {
        const index = this.shapes.indexOf(shape);
        if (index > -1) this.shapes.splice(index, 1);
    }

    getBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const shape of this.shapes) {
            const b = shape.getBounds();
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
        }
        return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    serialize() {
        return {
            type: this.type,
            x: this.x, y: this.y,
            shapes: this.shapes.map(s => s.serialize()),
            visible: this.visible, opacity: this.opacity,
            rotation: this.rotation, id: this.id
        };
    }

    static deserialize(data) {
        const shapes = data.shapes.map(s => {
            const ctors = { rectangle: VexelRectangle, ellipse: VexelEllipse, polygon: VexelPolygon, line: VexelLine, path: VexelPath, text: VexelText, image: VexelImage };
            const Ctor = ctors[s.type];
            return Ctor ? Ctor.deserialize(s) : null;
        }).filter(Boolean);
        return new VexelGroup(shapes, data);
    }

    toSVG() {
        let svg = `<g transform="translate(${this.x} ${this.y}) rotate(${this.rotation})" opacity="${this.opacity}">`;
        for (const shape of this.shapes) {
            svg += shape.toSVG();
        }
        svg += '</g>';
        return svg;
    }
}

if (typeof window !== 'undefined') {
    window.Vexel = Vexel;
    window.VexelRectangle = VexelRectangle;
    window.VexelEllipse = VexelEllipse;
    window.VexelPolygon = VexelPolygon;
    window.VexelLine = VexelLine;
    window.VexelPath = VexelPath;
    window.VexelText = VexelText;
    window.VexelImage = VexelImage;
    window.VexelGroup = VexelGroup;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Vexel, VexelRectangle, VexelEllipse, VexelPolygon,
        VexelLine, VexelPath, VexelText, VexelImage, VexelGroup
    };
}