/**
 * 测试用画布替身：Node 环境没有 DOM / OffscreenCanvas，
 * 这里提供最小的 2D 上下文与 canvas 对象（所有绘制调用为 no-op），
 * 让精灵构建与渲染器可以完整跑通生命周期逻辑（而不是真实像素）。
 *
 * 只用于测试；生产代码不会引用本文件。
 */

type Ctx = Record<string | symbol, unknown>;

function noop(): void { /* 绘制替身 */ }

function fakeCtx(): CanvasRenderingContext2D {
  const target: Ctx = {
    canvas: null,
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
  };
  return new Proxy(target, {
    get(store, prop) {
      if (prop in store) return store[prop];
      return noop;
    },
    set(store, prop, value) {
      store[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(): HTMLCanvasElement {
  const ctx = fakeCtx();
  const canvas = {
    width: 1,
    height: 1,
    clientWidth: 0,
    clientHeight: 0,
    getContext: () => ctx,
    toDataURL: () => 'data:,',
  };
  return canvas as unknown as HTMLCanvasElement;
}

export interface CanvasStub {
  restore(): void;
}

/** 安装最小画布环境；返回 restore 以便测试结束后还原。 */
export function installCanvasStub(): CanvasStub {
  const g = globalThis as unknown as Record<string, unknown>;
  const hadDocument = 'document' in g;
  const hadWindow = 'window' in g;
  const oldDocument = g.document;
  const oldWindow = g.window;

  const doc = {
    createElement: (tag: string) => (tag === 'canvas' ? fakeCanvas() : {}),
  };
  const win = {
    devicePixelRatio: 1,
    innerWidth: 640,
    innerHeight: 480,
    addEventListener: noop,
    removeEventListener: noop,
  };

  g.document = doc;
  g.window = win;

  return {
    restore(): void {
      if (hadDocument) g.document = oldDocument;
      else delete g.document;
      if (hadWindow) g.window = oldWindow;
      else delete g.window;
    },
  };
}

/** 方便断言：生成一个可被 Renderer 直接使用的假画布。 */
export function makeRendererCanvas(): HTMLCanvasElement {
  return fakeCanvas();
}
