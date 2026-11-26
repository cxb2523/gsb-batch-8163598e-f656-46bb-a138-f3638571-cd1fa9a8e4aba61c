// src/core/renderer.js
//
// Thin renderer facade. All state (viewport, canvas dimensions, pixel ratio,
// overlay) is owned by the engine (`vexel`). Rendering goes through the single
// engine render path so the main canvas, overlay, grid and exports can never
// disagree.

class VexelRenderer {
    constructor(vexel) {
        this.vexel = vexel;
        this.antialias = true;
        this.fps = 0;
        this.frameCount = 0;
        this.lastFPSTime = typeof performance !== 'undefined' ? performance.now() : 0;
        this.dirty = true;
        this.dirtyRegions = [];
        this.useDirtyRegions = false;
        this.maxDirtyRegions = 10;
        this.renderingEnabled = true;
        this.stats = {
            drawCalls: 0,
            shapesRendered: 0,
            framesRendered: 0,
            lastFrameTime: 0
        };
    }

    get backend() { return this.vexel.backend; }
    get pixelRatio() { return this.vexel.pixelRatio; }
    get webglRenderer() { return this.vexel.webglRenderer; }

    setBackend(backend) {
        return this.vexel.setBackend(backend);
    }

    render() {
        if (!this.renderingEnabled) return;

        const startTime = typeof performance !== 'undefined' ? performance.now() : 0;

        this.frameCount++;
        if (typeof performance !== 'undefined') {
            const now = performance.now();
            if (now - this.lastFPSTime >= 1000) {
                this.fps = this.frameCount;
                this.frameCount = 0;
                this.lastFPSTime = now;
            }
        }

        this.vexel.render();

        const shapes = this.vexel.shapes.length;
        this.stats.shapesRendered = shapes;
        this.stats.drawCalls = shapes;
        this.stats.framesRendered++;
        this.stats.lastFrameTime =
            (typeof performance !== 'undefined' ? performance.now() : 0) - startTime;
        this.dirty = false;
        this.dirtyRegions = [];
    }

    _renderOverlay(ctx) {
        this.vexel.renderSelectionOverlay(ctx);
    }

    setAntialias(enabled) {
        this.antialias = enabled;
        this.vexel.antialias = enabled;
        this.vexel.dirty = true;
    }

    setDirtyRegions(enabled) {
        this.useDirtyRegions = enabled;
    }

    markDirty(x, y, width, height) {
        this.dirty = true;
        if (x !== undefined) {
            this.dirtyRegions.push({ x, y, width, height });
            if (this.dirtyRegions.length > this.maxDirtyRegions) {
                this.dirtyRegions.shift();
            }
        }
    }

    markAllDirty() {
        this.dirty = true;
        this.dirtyRegions = [];
    }

    getFPS() {
        return this.fps;
    }

    getStats() {
        return {
            ...this.stats,
            backend: this.vexel.backend,
            fps: this.fps,
            pixelRatio: this.vexel.pixelRatio,
            antialias: this.antialias,
            dirty: this.vexel.dirty,
            totalShapes: this.vexel.shapes.length,
            selectedShapes: this.vexel.selectedShapes.length,
            viewportZoom: this.vexel.viewport.zoom,
            webgl: this.vexel.webglRenderer ? this.vexel.webglRenderer.getStats() : null
        };
    }

    /**
     * Render the current viewport to a fresh offscreen canvas. Does not read
     * back the on-screen canvas, so it works even if no frame has been drawn.
     */
    renderToCanvas(scale = 1, background = '#ffffff') {
        return this.vexel.renderToCanvas({ scale, background });
    }

    takeScreenshot(scale = 1, format = 'image/png') {
        return new Promise((resolve, reject) => {
            try {
                const canvas = this.renderToCanvas(scale);
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Failed to encode screenshot'));
                }, format);
            } catch (error) {
                reject(error);
            }
        });
    }

    enable() {
        this.renderingEnabled = true;
    }

    disable() {
        this.renderingEnabled = false;
    }

    destroy() {
        this.vexel._destroyWebGL();
    }
}

if (typeof window !== 'undefined') {
    window.VexelRenderer = VexelRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelRenderer;
}
