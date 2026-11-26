// src/core/viewport.js
//
// Adapter over the engine's authoritative viewport state. The engine
// (`vexel.viewport`) is the only object that owns offset/zoom/rotation; this
// class adds smooth-animation helpers on top of it so there is exactly one
// source of truth consumed by the main canvas, overlay, hit-testing and
// exports.

class VexelViewport {
    constructor(vexel) {
        this.vexel = vexel;
        // Make sure the shared state exists even if constructed standalone.
        if (!vexel.viewport) {
            vexel.viewport = { x: 0, y: 0, zoom: 1, rotation: 0 };
        }
        this.minZoom = 0.001;
        this.maxZoom = 100;
        this.zoomSensitivity = 0.001;
        this.scrollSensitivity = 1;
        this.homeX = 0;
        this.homeY = 0;
        this.homeZoom = 1;
        this.homeRotation = 0;
        this.smoothZoom = true;
        this.smoothPan = true;
        // Animation targets are separate from the live values, but live
        // values always live on vexel.viewport.
        this.targetX = 0;
        this.targetY = 0;
        this.targetZoom = 1;
        this.targetRotation = 0;
        this.animating = false;
        this.animationSpeed = 0.2;
        this.animationId = null;
        this.constraints = null;
        this.padding = { top: 0, right: 0, bottom: 0, left: 0 };
        this._syncTargetsFromState();
    }

    /* ---- authoritative live state accessors ---- */

    get state() {
        return this.vexel.viewport;
    }

    get x() { return this.vexel.viewport.x; }
    set x(value) { this.vexel.viewport.x = value; }

    get y() { return this.vexel.viewport.y; }
    set y(value) { this.vexel.viewport.y = value; }

    get zoom() { return this.vexel.viewport.zoom; }
    set zoom(value) { this.vexel.viewport.zoom = this._clampZoom(value); }

    get rotation() { return this.vexel.viewport.rotation; }
    set rotation(value) { this.vexel.viewport.rotation = value; }

    _clampZoom(value) {
        const min = Math.min(this.minZoom, this.maxZoom);
        const max = Math.max(this.minZoom, this.maxZoom);
        return Math.max(min, Math.min(max, value));
    }

    _syncTargetsFromState() {
        const vp = this.vexel.viewport;
        this.targetX = vp.x;
        this.targetY = vp.y;
        this.targetZoom = vp.zoom;
        this.targetRotation = vp.rotation;
    }

    _syncToVexel() {
        // Live values already alias vexel.viewport; just flag a redraw.
        this.vexel.dirty = true;
    }

    pan(dx, dy) {
        this.targetX += dx;
        this.targetY += dy;
        this._commit();
    }

    panTo(x, y) {
        this.targetX = x;
        this.targetY = y;
        this._commit();
    }

    zoomAt(factor, cx, cy) {
        const oldZoom = this.targetZoom;
        this.targetZoom = this._clampZoom(this.targetZoom * factor);

        if (cx !== undefined && cy !== undefined) {
            const ratio = this.targetZoom / oldZoom;
            this.targetX = cx - (cx - this.targetX) * ratio;
            this.targetY = cy - (cy - this.targetY) * ratio;
        }
        this._commit();
    }

    zoomIn(factor = 1.2) {
        const cx = this.vexel.width / 2;
        const cy = this.vexel.height / 2;
        this.zoomAt(factor, cx, cy);
    }

    zoomOut(factor = 0.8) {
        this.zoomIn(factor);
    }

    zoomToFit(shapes, padding = 50) {
        if (!shapes || shapes.length === 0) {
            this.reset();
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
        const zoomX = (this.vexel.width - this.padding.left - this.padding.right) / contentWidth;
        const zoomY = (this.vexel.height - this.padding.top - this.padding.bottom) / contentHeight;
        const zoom = this._clampZoom(Math.min(zoomX, zoomY, 1));

        this.targetZoom = zoom;
        this.targetX = (this.vexel.width - contentWidth * zoom) / 2 - minX * zoom + padding * zoom + this.padding.left;
        this.targetY = (this.vexel.height - contentHeight * zoom) / 2 - minY * zoom + padding * zoom + this.padding.top;
        this.targetRotation = 0;
        this._commit();
    }

    zoomToSelection() {
        if (this.vexel.selectedShapes.length > 0) {
            this.zoomToFit(this.vexel.selectedShapes, 30);
        }
    }

    zoomToPercent(percent) {
        this.targetZoom = this._clampZoom(percent / 100);
        this.targetX = (this.vexel.width - this.vexel.width * this.targetZoom) / 2;
        this.targetY = (this.vexel.height - this.vexel.height * this.targetZoom) / 2;
        this._commit();
    }

    // Rotation is stored in radians (matching ctx.rotate). These helpers
    // accept radians too, for consistency with the authoritative state.
    rotate(angle) {
        this.targetRotation = (this.targetRotation + angle) % (Math.PI * 2);
        this.rotation = this.targetRotation;
        this._syncToVexel();
    }

    rotateTo(angle) {
        this.targetRotation = angle % (Math.PI * 2);
        this.rotation = this.targetRotation;
        this._syncToVexel();
    }

    reset() {
        this.targetX = this.homeX;
        this.targetY = this.homeY;
        this.targetZoom = this.homeZoom;
        this.targetRotation = this.homeRotation;
        this._commit();
    }

    setHome() {
        this.homeX = this.x;
        this.homeY = this.y;
        this.homeZoom = this.zoom;
        this.homeRotation = this.rotation;
    }

    goHome() {
        this.reset();
    }

    setConstraints(bounds) {
        this.constraints = bounds;
    }

    clearConstraints() {
        this.constraints = null;
    }

    _applyConstraints() {
        if (!this.constraints) return;

        const visibleWidth = this.vexel.width / this.targetZoom;
        const visibleHeight = this.vexel.height / this.targetZoom;

        if (visibleWidth < this.constraints.width) {
            const minX = this.constraints.x;
            const maxX = this.constraints.x + this.constraints.width - visibleWidth;
            this.targetX = Math.max(minX, Math.min(maxX, this.targetX));
        } else {
            this.targetX = this.constraints.x + (this.constraints.width - visibleWidth) / 2;
        }

        if (visibleHeight < this.constraints.height) {
            const minY = this.constraints.y;
            const maxY = this.constraints.y + this.constraints.height - visibleHeight;
            this.targetY = Math.max(minY, Math.min(maxY, this.targetY));
        } else {
            this.targetY = this.constraints.y + (this.constraints.height - visibleHeight) / 2;
        }
    }

    _commit() {
        if (this.smoothZoom || this.smoothPan) {
            this._startSmoothAnimation();
        } else {
            this.animating = false;
            this._applyConstraints();
            this.vexel.viewport.x = this.targetX;
            this.vexel.viewport.y = this.targetY;
            this.vexel.viewport.zoom = this._clampZoom(this.targetZoom);
            this.vexel.viewport.rotation = this.targetRotation;
            this._syncToVexel();
        }
    }

    _startSmoothAnimation() {
        if (this.animating) return;
        this.animating = true;
        const step = () => {
            if (!this.animating) return;
            this._animateStep();
        };
        this.animationId = requestAnimationFrame(step);
    }

    _animateStep() {
        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        const dz = this.targetZoom - this.zoom;

        if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01 && Math.abs(dz) < 0.0001) {
            this.animating = false;
            this._applyConstraints();
            this.vexel.viewport.x = this.targetX;
            this.vexel.viewport.y = this.targetY;
            this.vexel.viewport.zoom = this._clampZoom(this.targetZoom);
            this.vexel.viewport.rotation = this.targetRotation;
            this._syncToVexel();
            return;
        }

        const nextX = this.x + dx * this.animationSpeed;
        const nextY = this.y + dy * this.animationSpeed;
        const nextZoom = this._clampZoom(this.zoom + dz * this.animationSpeed);

        this.vexel.viewport.x = nextX;
        this.vexel.viewport.y = nextY;
        this.vexel.viewport.zoom = nextZoom;
        this._syncToVexel();

        this.animationId = requestAnimationFrame(() => this._animateStep());
    }

    screenToWorld(screenX, screenY) {
        return this.vexel.screenToWorld(screenX, screenY);
    }

    worldToScreen(worldX, worldY) {
        return this.vexel.worldToScreen(worldX, worldY);
    }

    getVisibleBounds() {
        return this.vexel.getVisibleWorldBounds();
    }

    isShapeVisible(shape) {
        const bounds = this.getVisibleBounds();
        const shapeBounds = shape.getBounds();
        const margin = 50;

        return !(
            shapeBounds.x + shapeBounds.width < bounds.x - margin ||
            shapeBounds.x > bounds.x + bounds.width + margin ||
            shapeBounds.y + shapeBounds.height < bounds.y - margin ||
            shapeBounds.y > bounds.y + bounds.height + margin
        );
    }

    getVisibleShapes(shapes) {
        return shapes ? shapes.filter(s => this.isShapeVisible(s)) : [];
    }

    setPadding(top, right, bottom, left) {
        this.padding = { top, right, bottom, left };
    }

    setZoomLimits(min, max) {
        this.minZoom = min;
        this.maxZoom = max;
        const zoom = this._clampZoom(this.vexel.viewport.zoom);
        this.vexel.viewport.zoom = zoom;
        this.targetZoom = this._clampZoom(this.targetZoom);
    }

    getZoomPercent() {
        return Math.round(this.zoom * 100);
    }

    getCenter() {
        return this.vexel.screenToWorld(this.vexel.width / 2, this.vexel.height / 2);
    }

    centerOn(x, y) {
        this.targetX = this.vexel.width / 2 - x * this.targetZoom;
        this.targetY = this.vexel.height / 2 - y * this.targetZoom;
        this._commit();
    }

    serialize() {
        return {
            x: this.x,
            y: this.y,
            zoom: this.zoom,
            rotation: this.rotation,
            homeX: this.homeX,
            homeY: this.homeY,
            homeZoom: this.homeZoom,
            homeRotation: this.homeRotation
        };
    }

    deserialize(data) {
        if (!data) return;
        this.vexel.viewport.x = data.x || 0;
        this.vexel.viewport.y = data.y || 0;
        this.vexel.viewport.zoom = this._clampZoom(data.zoom || 1);
        this.vexel.viewport.rotation = data.rotation || 0;
        this.homeX = data.homeX || 0;
        this.homeY = data.homeY || 0;
        this.homeZoom = data.homeZoom || 1;
        this.homeRotation = data.homeRotation || 0;
        this._syncTargetsFromState();
        this._syncToVexel();
    }

    destroy() {
        this.animating = false;
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
    }
}

if (typeof window !== 'undefined') {
    window.VexelViewport = VexelViewport;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelViewport;
}
