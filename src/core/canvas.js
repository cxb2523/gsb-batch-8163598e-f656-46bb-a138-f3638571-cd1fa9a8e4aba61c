// src/core/canvas.js
//
// Canvas controller/helpers. Viewport state and drawing live on the engine
// (`vexel.viewport`, `vexel.applyViewTransform`); this class only exposes
// convenience APIs and delegates so it cannot drift from the overlay or
// from exports.

class VexelCanvas {
    constructor(vexel) {
        this.vexel = vexel;
        this.minZoom = 0.001;
        this.maxZoom = 100;
        this.gridVisible = false;
        this.gridSize = 20;
        this.gridColor = 'rgba(128,128,128,0.15)';
        this.gridThickColor = 'rgba(128,128,128,0.3)';
        this.gridThickEvery = 5;
        this.snapEnabled = false;
        this.snapSize = 10;
        this.snapThreshold = 5;
        this.guidesVisible = false;
        this.guides = [];
        this.rulersVisible = false;
        this.rulerSize = 20;
        this.background = '#ffffff';
        this.overscroll = 500;
        this.bounceEnabled = true;
        this.bounceDamping = 0.3;
        this.inertiaEnabled = true;
        this.inertiaDamping = 0.95;
        this.velocityX = 0;
        this.velocityY = 0;
        this.lastPanX = 0;
        this.lastPanY = 0;
        this.animating = false;
        this.animationId = null;
    }

    /* ---- delegate to authoritative engine state ---- */

    get width() { return this.vexel.width; }
    get height() { return this.vexel.height; }
    get zoom() { return this.vexel.viewport.zoom; }
    get panX() { return this.vexel.viewport.x; }
    get panY() { return this.vexel.viewport.y; }
    get rotation() { return this.vexel.viewport.rotation; }

    resize(width, height) {
        this.vexel.resize(width, height);
    }

    get pixelRatio() {
        return this.vexel.pixelRatio;
    }

    setZoom(zoom, cx, cy) {
        this.vexel.setZoom(zoom, cx, cy);
    }

    zoomIn(factor = 1.2, cx, cy) {
        if (cx === undefined || cy === undefined) {
            cx = this.width / 2;
            cy = this.height / 2;
        }
        this.setZoom(this.zoom * factor, cx, cy);
    }

    zoomOut(factor = 0.8, cx, cy) {
        this.zoomIn(factor, cx, cy);
    }

    zoomToFit(shapes, padding = 50) {
        const vp = this.vexel.viewport;
        if (!shapes || shapes.length === 0) {
            this.resetView();
            return;
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const shape of shapes) {
            const b = shape.getBounds();
            minX = Math.min(minX, b.x);
            minY = Math.min(minY, b.y);
            maxX = Math.max(maxX, b.x + b.width);
            maxY = Math.max(maxY, b.y + b.height);
        }

        const contentWidth = maxX - minX + padding * 2;
        const contentHeight = maxY - minY + padding * 2;
        const zoom = this.vexel.clampZoom(Math.min(this.width / contentWidth, this.height / contentHeight, 1));

        vp.zoom = zoom;
        vp.x = (this.width - contentWidth * zoom) / 2 - minX * zoom + padding * zoom;
        vp.y = (this.height - contentHeight * zoom) / 2 - minY * zoom + padding * zoom;
        vp.rotation = 0;
        this.vexel.dirty = true;
    }

    zoomToSelection() {
        if (this.vexel.selectedShapes.length > 0) {
            this.zoomToFit(this.vexel.selectedShapes, 30);
        }
    }

    resetView() {
        this.vexel.resetView();
    }

    pan(dx, dy) {
        const vp = this.vexel.viewport;
        vp.x += dx;
        vp.y += dy;

        if (this.bounceEnabled) {
            const overscrollX = this._calculateOverscrollX();
            const overscrollY = this._calculateOverscrollY();
            if (overscrollX !== 0) vp.x -= overscrollX * this.bounceDamping;
            if (overscrollY !== 0) vp.y -= overscrollY * this.bounceDamping;
        }

        this.vexel.dirty = true;
    }

    _calculateOverscrollX() {
        const visibleWidth = this.width / this.zoom;
        const contentLeft = -this.overscroll;
        const contentRight = visibleWidth + this.overscroll;
        const currentLeft = -this.panX / this.zoom;
        const currentRight = (this.width - this.panX) / this.zoom;

        if (currentLeft < contentLeft) return (currentLeft - contentLeft) * this.zoom;
        if (currentRight > contentRight) return (currentRight - contentRight) * this.zoom;
        return 0;
    }

    _calculateOverscrollY() {
        const visibleHeight = this.height / this.zoom;
        const contentTop = -this.overscroll;
        const contentBottom = visibleHeight + this.overscroll;
        const currentTop = -this.panY / this.zoom;
        const currentBottom = (this.height - this.panY) / this.zoom;

        if (currentTop < contentTop) return (currentTop - contentTop) * this.zoom;
        if (currentBottom > contentBottom) return (currentBottom - contentBottom) * this.zoom;
        return 0;
    }

    startInertia(vx, vy) {
        if (!this.inertiaEnabled) return;
        this.velocityX = vx;
        this.velocityY = vy;
        if (!this.animating) {
            this._animateInertia();
        }
    }

    _animateInertia() {
        this.animating = true;

        const step = () => {
            this.velocityX *= this.inertiaDamping;
            this.velocityY *= this.inertiaDamping;

            if (Math.abs(this.velocityX) < 0.01 && Math.abs(this.velocityY) < 0.01) {
                this.animating = false;
                this.velocityX = 0;
                this.velocityY = 0;
                return;
            }

            this.pan(this.velocityX, this.velocityY);
            this.animationId = requestAnimationFrame(step);
        };

        this.animationId = requestAnimationFrame(step);
    }

    stopInertia() {
        this.animating = false;
        this.velocityX = 0;
        this.velocityY = 0;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }

    screenToCanvas(screenX, screenY) {
        return this.vexel.screenToWorld(screenX, screenY);
    }

    canvasToScreen(canvasX, canvasY) {
        return this.vexel.worldToScreen(canvasX, canvasY);
    }

    setGrid(visible, size, color, thickColor, thickEvery) {
        this.gridVisible = visible;
        if (size !== undefined) this.gridSize = size;
        if (color !== undefined) this.gridColor = color;
        if (thickColor !== undefined) this.gridThickColor = thickColor;
        if (thickEvery !== undefined) this.gridThickEvery = thickEvery;
        this.vexel.gridEnabled = visible;
        if (size !== undefined) this.vexel.snapSize = size;
        this.vexel.dirty = true;
    }

    setSnap(enabled, size, threshold) {
        this.snapEnabled = enabled;
        if (size !== undefined) this.snapSize = size;
        if (threshold !== undefined) this.snapThreshold = threshold;
        this.vexel.snapEnabled = enabled;
        if (size !== undefined) this.vexel.snapSize = size;
    }

    snapPoint(x, y) {
        if (!this.snapEnabled) return { x, y };

        const snappedX = Math.round(x / this.snapSize) * this.snapSize;
        const snappedY = Math.round(y / this.snapSize) * this.snapSize;

        const distX = Math.abs(snappedX - x);
        const distY = Math.abs(snappedY - y);

        return {
            x: distX <= this.snapThreshold ? snappedX : x,
            y: distY <= this.snapThreshold ? snappedY : y
        };
    }

    addGuide(orientation, position, color = '#FF5722') {
        this.guides.push({ orientation, position, color });
        this.guidesVisible = true;
        this.vexel.dirty = true;
        return this.guides.length - 1;
    }

    removeGuide(index) {
        if (index >= 0 && index < this.guides.length) {
            this.guides.splice(index, 1);
            this.vexel.dirty = true;
        }
    }

    clearGuides() {
        this.guides = [];
        this.vexel.dirty = true;
    }

    drawGuides(ctx) {
        if (!this.guidesVisible || this.guides.length === 0) return;

        const vp = this.vexel.viewport;
        const zoom = vp.zoom;
        ctx.save();
        this.vexel.applyViewTransform(ctx);

        for (const guide of this.guides) {
            ctx.strokeStyle = guide.color || '#FF5722';
            ctx.lineWidth = 1 / zoom;
            ctx.setLineDash([4 / zoom, 4 / zoom]);

            if (guide.orientation === 'horizontal') {
                ctx.beginPath();
                ctx.moveTo(-vp.x / zoom, guide.position);
                ctx.lineTo((this.width - vp.x) / zoom, guide.position);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.moveTo(guide.position, -vp.y / zoom);
                ctx.lineTo(guide.position, (this.height - vp.y) / zoom);
                ctx.stroke();
            }

            ctx.setLineDash([]);
        }

        ctx.restore();
    }

    drawRulers(ctx) {
        if (!this.rulersVisible) return;
        this.vexel.rulersVisible = true;
        this.vexel.rulerSize = this.rulerSize;
        this.vexel._drawRulers(ctx);
    }

    drawGrid(ctx) {
        if (!this.gridVisible) return;
        this.vexel.gridEnabled = true;
        this.vexel.gridSize = this.gridSize;
        this.vexel.gridColor = this.gridColor;
        this.vexel.gridThickColor = this.gridThickColor;
        this.vexel.gridThickEvery = this.gridThickEvery;
        this.vexel._drawGrid(ctx);
    }

    getVisibleBounds() {
        return this.vexel.getVisibleWorldBounds();
    }

    getVisibleShapes(shapes) {
        const bounds = this.getVisibleBounds();
        const padding = 100;

        return shapes.filter(shape => {
            const sb = shape.getBounds();
            return (
                sb.x + sb.width >= bounds.x - padding &&
                sb.x <= bounds.x + bounds.width + padding &&
                sb.y + sb.height >= bounds.y - padding &&
                sb.y <= bounds.y + bounds.height + padding
            );
        });
    }
}

if (typeof window !== 'undefined') {
    window.VexelCanvas = VexelCanvas;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelCanvas;
}
