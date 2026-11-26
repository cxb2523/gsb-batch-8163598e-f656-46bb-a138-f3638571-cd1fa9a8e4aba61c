// src/core/engine.js
//
// Render-engine facade. Delegates to the engine's single render path and
// authoritative viewport. Any transform, grid, overlay or export produced
// here is identical to what the screen shows.

class VexelRenderEngine {
    constructor(vexel) {
        this.vexel = vexel;
        this.antialias = true;
        this.fps = 0;
        this.frameCount = 0;
        this.lastFPSTime = typeof performance !== 'undefined' ? performance.now() : 0;
        this.dirtyRegions = [];
        this.useDirtyRegions = false;
        this.maxDirtyRegions = 10;
    }

    get backend() { return this.vexel.backend; }
    get pixelRatio() { return this.vexel.pixelRatio; }

    setBackend(backend) {
        const backends = ['canvas2d', 'webgl', 'webgl2', 'offscreen', 'svg', '2d'];
        if (!backends.includes(backend)) {
            throw new Error(`Unsupported backend: ${backend}. Use: ${backends.join(', ')}`);
        }
        // 'webgl2' is served by the same WebGL renderer; the rest fall back.
        const normalized = backend === 'webgl2' ? 'webgl' : backend;
        if (normalized === 'webgl') {
            this.vexel.setBackend('webgl');
        } else if (normalized === 'canvas2d' || normalized === '2d') {
            this.vexel.setBackend('canvas2d');
        } else {
            this.vexel.setBackend(normalized);
        }
        return this.vexel.backend;
    }

    render() {
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
        this.dirtyRegions = [];
    }

    renderGrid(ctx) {
        this.vexel._drawGrid(ctx);
    }

    renderSelectionOverlay(ctx) {
        this.vexel.renderSelectionOverlay(ctx);
    }

    renderGuides(ctx) {
        if (this.vexel.canvas && this.vexel.canvas.drawGuides) {
            this.vexel.canvas.drawGuides(ctx);
        }
    }

    getFPS() {
        return this.fps;
    }

    getMemoryUsage() {
        if (typeof performance !== 'undefined' && performance.memory) {
            return {
                usedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                limitJSHeapSize: performance.memory.jsHeapSizeLimit
            };
        }
        return null;
    }

    getStats() {
        return {
            backend: this.vexel.backend,
            fps: this.fps,
            shapeCount: this.vexel.shapes.length,
            selectedCount: this.vexel.selectedShapes.length,
            viewportZoom: this.vexel.viewport.zoom,
            memory: this.getMemoryUsage(),
            pixelRatio: this.vexel.pixelRatio,
            antialias: this.antialias
        };
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
        if (this.dirtyRegions.length >= this.maxDirtyRegions) {
            this.dirtyRegions.shift();
        }
        this.dirtyRegions.push({ x, y, width, height });
    }

    markAllDirty() {
        this.dirtyRegions = [{ x: 0, y: 0, width: this.vexel.width, height: this.vexel.height }];
    }

    takeScreenshot(scale = 1) {
        return new Promise((resolve, reject) => {
            try {
                const canvas = this.vexel.renderToCanvas({ scale });
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Failed to encode screenshot'));
                }, 'image/png');
            } catch (error) {
                reject(error);
            }
        });
    }
}

if (typeof window !== 'undefined') {
    window.VexelRenderEngine = VexelRenderEngine;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelRenderEngine;
}
