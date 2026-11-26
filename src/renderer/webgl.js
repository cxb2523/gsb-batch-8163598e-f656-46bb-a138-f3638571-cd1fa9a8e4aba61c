// src/renderer/webgl.js
//
// Optional GPU backend. It renders into its own offscreen canvas which the
// engine composites into the main 2D canvas. It never replaces the engine's
// DOM canvas, so switching backends cannot leave stray canvases behind and
// the shared viewport transform is the only thing that positions geometry.

class VexelWebGLRenderer {
    constructor(vexel) {
        this.vexel = vexel;
        this.canvas = null;
        this.gl = null;
        this.programs = {};
        this.buffers = {};
        this.initialized = false;
        this.maxTextureSize = 4096;
        this.batchSize = 1000;
        this.drawCalls = 0;
        this.pixelRatio = 1;
        this.width = vexel.width;
        this.height = vexel.height;
        this.supportedTypes = new Set(['rectangle', 'ellipse', 'line', 'polygon', 'path']);
        this._colorCache = new Map();
    }

    init(options = {}) {
        this.width = Math.max(1, Math.round(options.width || this.vexel.width));
        this.height = Math.max(1, Math.round(options.height || this.vexel.height));
        this.pixelRatio = Math.max(0.0001, options.pixelRatio || this.vexel.pixelRatio || 1);

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(this.width * this.pixelRatio));
        canvas.height = Math.max(1, Math.round(this.height * this.pixelRatio));
        this.canvas = canvas;

        const attributes = {
            alpha: true,
            antialias: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance',
            failIfMajorPerformanceCaveat: false
        };

        this.gl = canvas.getContext('webgl2', attributes) ||
            canvas.getContext('webgl', attributes) ||
            canvas.getContext('experimental-webgl', attributes);

        if (!this.gl) {
            this.canvas = null;
            return false;
        }

        try {
            this._createShaders();
            this._createBuffers();
            this._setupState();
        } catch (error) {
            console.warn('WebGL setup failed:', error);
            this.destroy();
            return false;
        }

        if (!this.programs.main) {
            this.destroy();
            return false;
        }

        this.initialized = true;
        return true;
    }

    resize(width, height, pixelRatio = this.pixelRatio) {
        this.width = Math.max(1, Math.round(width));
        this.height = Math.max(1, Math.round(height));
        this.pixelRatio = Math.max(0.0001, pixelRatio);
        if (this.canvas) {
            this.canvas.width = Math.max(1, Math.round(this.width * this.pixelRatio));
            this.canvas.height = Math.max(1, Math.round(this.height * this.pixelRatio));
        }
        if (this.gl) {
            this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        }
    }

    _createShaders() {
        const vertexShaderSource = `
            attribute vec2 a_position;
            attribute vec4 a_color;
            uniform mat3 u_matrix;
            varying vec4 v_color;
            void main() {
                vec3 position = u_matrix * vec3(a_position, 1.0);
                gl_Position = vec4(position.xy, 0.0, 1.0);
                v_color = a_color;
            }
        `;

        const fragmentShaderSource = `
            precision mediump float;
            varying vec4 v_color;
            void main() {
                gl_FragColor = v_color;
            }
        `;

        this.programs.main = this._compileShader(vertexShaderSource, fragmentShaderSource);
    }

    _compileShader(vertexSource, fragmentSource) {
        const gl = this.gl;

        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, vertexSource);
        gl.compileShader(vertexShader);
        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
            throw new Error('Vertex shader error: ' + gl.getShaderInfoLog(vertexShader));
        }

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, fragmentSource);
        gl.compileShader(fragmentShader);
        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
            throw new Error('Fragment shader error: ' + gl.getShaderInfoLog(fragmentShader));
        }

        const program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error('Program link error: ' + gl.getProgramInfoLog(program));
        }

        return {
            program,
            uniforms: {
                matrix: gl.getUniformLocation(program, 'u_matrix')
            },
            attributes: {
                position: gl.getAttribLocation(program, 'a_position'),
                color: gl.getAttribLocation(program, 'a_color')
            }
        };
    }

    _createBuffers() {
        const gl = this.gl;
        this.buffers.position = gl.createBuffer();
        this.buffers.color = gl.createBuffer();
    }

    _setupState() {
        const gl = this.gl;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }

    begin() {
        if (!this.initialized || !this.gl) throw new Error('WebGL renderer is not initialized');
        const gl = this.gl;
        this.drawCalls = 0;

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clear(gl.COLOR_BUFFER_BIT);

        const program = this.programs.main;
        gl.useProgram(program.program);
        gl.uniformMatrix3fv(program.uniforms.matrix, false, this._getViewMatrix());
    }

    end() {
        if (this.gl) this.gl.flush();
    }

    /**
     * Build the world -> clip-space matrix from the engine's authoritative
     * viewport (offset + zoom + rotation) and the canvas CSS/logical size.
     * Column-major, suitable for uniformMatrix3fv.
     */
    _getViewMatrix() {
        const vp = this.vexel.viewport;
        const w = this.width;
        const h = this.height;
        const zoom = vp.zoom;
        const theta = vp.rotation || 0;
        const cos = Math.cos(theta);
        const sin = Math.sin(theta);

        const c = zoom * cos;
        const s = zoom * sin;

        const sx = (2 * c) / w;
        const sy = (-2 * s) / h;
        const tx = (-2 * s) / w;
        const ty = (-2 * c) / h;
        const ox = (2 * vp.x) / w - 1;
        const oy = 1 - (2 * vp.y) / h;

        return new Float32Array([
            sx, sy, 0,
            tx, ty, 0,
            ox, oy, 1
        ]);
    }

    supportsShape(shape) {
        return !!shape && this.supportedTypes.has(shape.type);
    }

    drawShape(shape) {
        switch (shape.type) {
            case 'rectangle': return this.drawRect(shape);
            case 'ellipse': return this.drawEllipse(shape);
            case 'line': return this.drawLine(shape);
            case 'polygon': return this.drawPolygon(shape);
            case 'path': return this.drawPath(shape);
            default: return false;
        }
    }

    _parseColor(input, fallback = 0x000000FF) {
        if (input === undefined || input === null || input === 'transparent' || input === 'none') {
            return fallback;
        }
        const key = String(input);
        if (this._colorCache.has(key)) return this._colorCache.get(key);

        let result = fallback;
        if (typeof VexelColor !== 'undefined' && VexelColor.parse) {
            const parsed = VexelColor.parse(input);
            if (parsed) {
                const alpha = parsed.a !== undefined ? parsed.a : 1;
                result = (Math.round(alpha * 255) << 24) |
                    (parsed.b << 16) | (parsed.g << 8) | parsed.r;
            }
        }
        this._colorCache.set(key, result);
        return result;
    }

    _upload(positions, colors) {
        const gl = this.gl;
        const program = this.programs.main;

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(program.attributes.position);
        gl.vertexAttribPointer(program.attributes.position, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(program.attributes.color);
        gl.vertexAttribPointer(program.attributes.color, 4, gl.FLOAT, false, 0, 0);
    }

    _pushColor(colors, color) {
        const r = ((color >> 16) & 0xFF) / 255;
        const g = ((color >> 8) & 0xFF) / 255;
        const b = (color & 0xFF) / 255;
        const a = ((color >> 24) & 0xFF) / 255;
        colors.push(r, g, b, a);
    }

    _fillBuffer(colors, count, color) {
        const r = ((color >> 16) & 0xFF) / 255;
        const g = ((color >> 8) & 0xFF) / 255;
        const b = (color & 0xFF) / 255;
        const a = ((color >> 24) & 0xFF) / 255;
        for (let i = 0; i < count; i++) colors.push(r, g, b, a);
    }

    drawRect(shape) {
        // Accept either a shape object or raw geometry.
        let x, y, width, height, rotation = 0, color;
        if (typeof shape === 'object' && shape !== null && shape.type === 'rectangle') {
            x = shape.x;
            y = shape.y;
            width = shape.width * (shape.scaleX === undefined ? 1 : shape.scaleX);
            height = shape.height * (shape.scaleY === undefined ? 1 : shape.scaleY);
            rotation = (shape.rotation || 0) * Math.PI / 180;
            const fill = shape.fill && shape.fill !== 'transparent'
                ? this._parseColor(shape.fill, 0xFF5722FF)
                : this._parseColor(shape.stroke, 0xFF5722FF);
            color = this._applyOpacity(fill, shape.opacity);
        } else {
            x = arguments[0];
            y = arguments[1];
            width = arguments[2];
            height = arguments[3];
            color = arguments[4] === undefined ? 0xFF5722FF : arguments[4];
        }

        const cx = x + width / 2;
        const cy = y + height / 2;
        const corners = this._rotateCorners(
            [
                { x, y },
                { x: x + width, y },
                { x: x + width, y: y + height },
                { x, y: y + height }
            ],
            cx, cy, rotation
        );

        const positions = [];
        const colors = [];
        const tris = [0, 1, 2, 0, 2, 3];
        for (const i of tris) {
            positions.push(corners[i].x, corners[i].y);
            this._pushColor(colors, color);
        }

        this._upload(positions, colors);
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
        this.drawCalls++;
        return true;
    }

    drawEllipse(shape, arg1, arg2, arg3) {
        let cx, cy, rx, ry, color, rotation = 0;
        const segments = 64;

        if (typeof shape === 'object' && shape !== null && shape.type === 'ellipse') {
            cx = shape.x;
            cy = shape.y;
            rx = shape.radiusX;
            ry = shape.radiusY;
            rotation = (shape.rotation || 0) * Math.PI / 180;
            const fill = shape.fill && shape.fill !== 'transparent'
                ? this._parseColor(shape.fill, 0xFF5722FF)
                : this._parseColor(shape.stroke, 0xFF5722FF);
            color = this._applyOpacity(fill, shape.opacity);
        } else {
            cx = arguments[0];
            cy = arguments[1];
            rx = arguments[2];
            ry = arguments[3];
            color = arguments[4] === undefined ? 0xFF5722FF : arguments[4];
        }

        const positions = [cx, cy];
        const cosR = Math.cos(rotation);
        const sinR = Math.sin(rotation);
        for (let i = 0; i <= segments; i++) {
            const angle = (i / segments) * Math.PI * 2;
            const px = Math.cos(angle) * rx;
            const py = Math.sin(angle) * ry;
            positions.push(cx + px * cosR - py * sinR, cy + px * sinR + py * cosR);
        }

        const colors = [];
        this._fillBuffer(colors, segments + 2, color);

        this._upload(positions, colors);
        this.gl.drawArrays(this.gl.TRIANGLE_FAN, 0, segments + 2);
        this.drawCalls++;
        return true;
    }

    drawLine(shape, arg1, arg2, arg3, arg4) {
        let x1, y1, x2, y2, color, strokeWidth;
        if (typeof shape === 'object' && shape !== null && shape.type === 'line') {
            x1 = shape.x1;
            y1 = shape.y1;
            x2 = shape.x2;
            y2 = shape.y2;
            strokeWidth = shape.strokeWidth || 1;
            color = this._applyOpacity(this._parseColor(shape.stroke, 0x000000FF), shape.opacity);
        } else {
            x1 = arguments[0];
            y1 = arguments[1];
            x2 = arguments[2];
            y2 = arguments[3];
            color = arguments[4] === undefined ? 0x000000FF : arguments[4];
            strokeWidth = arguments[5] === undefined ? 1 : arguments[5];
        }

        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return false;
        const nx = -dy / len * strokeWidth / 2;
        const ny = dx / len * strokeWidth / 2;

        const positions = [
            x1 + nx, y1 + ny, x1 - nx, y1 - ny, x2 + nx, y2 + ny,
            x1 - nx, y1 - ny, x2 - nx, y2 - ny, x2 + nx, y2 + ny
        ];
        const colors = [];
        this._fillBuffer(colors, 6, color);

        this._upload(positions, colors);
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
        this.drawCalls++;
        return true;
    }

    drawPolygon(shape) {
        let cx, cy, sides, radius, color, rotation = 0;
        if (typeof shape === 'object' && shape !== null && shape.type === 'polygon') {
            cx = shape.x;
            cy = shape.y;
            sides = shape.sides;
            radius = shape.radius;
            rotation = (shape.rotation || 0) * Math.PI / 180 - Math.PI / 2;
            const fill = shape.fill && shape.fill !== 'transparent'
                ? this._parseColor(shape.fill, 0xFF5722FF)
                : this._parseColor(shape.stroke, 0xFF5722FF);
            color = this._applyOpacity(fill, shape.opacity);
        } else {
            return false;
        }

        const vertices = [];
        for (let i = 0; i < sides; i++) {
            const angle = rotation + (i * Math.PI * 2) / sides;
            vertices.push({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
        }
        return this._drawTriangleFanFromVertices(vertices, color);
    }

    drawPath(shape) {
        if (typeof shape !== 'object' || !Array.isArray(shape.points) || shape.points.length < 3) {
            return false;
        }
        const fill = shape.fill && shape.fill !== 'transparent'
            ? this._parseColor(shape.fill, 0xFF5722FF)
            : this._parseColor(shape.stroke, 0xFF5722FF);
        const color = this._applyOpacity(fill, shape.opacity);
        return this._drawTriangleFanFromVertices(shape.points, color);
    }

    _drawTriangleFanFromVertices(vertices, color) {
        const positions = [];
        const colors = [];
        for (let i = 0; i < vertices.length; i++) {
            const a = vertices[i];
            const b = vertices[(i + 1) % vertices.length];
            positions.push(a.x, a.y, b.x, b.y);
            this._pushColor(colors, color);
            this._pushColor(colors, color);
        }
        this._upload(positions, colors);
        this.gl.drawArrays(this.gl.TRIANGLES, 0, positions.length / 2);
        this.drawCalls++;
        return true;
    }

    _rotateCorners(corners, cx, cy, rotation) {
        if (!rotation) return corners;
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        return corners.map(p => {
            const dx = p.x - cx;
            const dy = p.y - cy;
            return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
        });
    }

    _applyOpacity(color, opacity) {
        if (opacity === undefined || opacity === null || opacity >= 1) return color;
        const alpha = Math.max(0, Math.min(255, Math.round(((color >> 24) & 0xFF) * opacity)));
        return (alpha << 24) | (color & 0x00FFFFFF);
    }

    setScissor(x, y, width, height) {
        const gl = this.gl;
        const scale = this.pixelRatio;
        gl.scissor(
            Math.round(x * scale),
            Math.round((this.height - y - height) * scale),
            Math.round(width * scale),
            Math.round(height * scale)
        );
    }

    clearScissor() {
        if (!this.canvas) return;
        this.gl.scissor(0, 0, this.canvas.width, this.canvas.height);
    }

    createTexture(image) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return texture;
    }

    getStats() {
        return {
            drawCalls: this.drawCalls,
            initialized: this.initialized,
            renderer: this.gl && this.gl.getParameter
                ? (this.gl.getParameter(this.gl.VERSION) || 'WebGL')
                : 'WebGL',
            maxTextureSize: this.maxTextureSize,
            pixelRatio: this.pixelRatio
        };
    }

    destroy() {
        const gl = this.gl;
        if (gl) {
            for (const key of Object.keys(this.buffers)) {
                if (this.buffers[key]) gl.deleteBuffer(this.buffers[key]);
            }
            for (const key of Object.keys(this.programs)) {
                const entry = this.programs[key];
                if (entry && entry.program) gl.deleteProgram(entry.program);
            }
            const lose = gl.getExtension && gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
        }
        this.buffers = {};
        this.programs = {};
        this.gl = null;
        this.canvas = null;
        this.initialized = false;
        this._colorCache.clear();
    }
}

if (typeof window !== 'undefined') {
    window.VexelWebGLRenderer = VexelWebGLRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = VexelWebGLRenderer;
}
