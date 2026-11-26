/**
 * 测试用 DOM 替身：足够支撑 App / Hud 的最小元素与浏览器 API，
 * 用来验证「销毁 App / 返回标题 → 释放精灵缓存 → 重新进入可重建」这条
 * 生命周期，而不是验证真实像素。
 *
 * 只用于测试；生产代码不会引用本文件。
 */

type Listener = (ev: unknown) => void;

class FakeClassList {
  private readonly set = new Set<string>();

  constructor(initial: string) {
    for (const c of initial.split(/\s+/)) if (c) this.set.add(c);
  }

  add(...names: string[]): void {
    for (const n of names) this.set.add(n);
  }

  remove(...names: string[]): void {
    for (const n of names) this.set.delete(n);
  }

  toggle(name: string, force?: boolean): boolean {
    const on = force ?? !this.set.has(name);
    if (on) this.set.add(name);
    else this.set.delete(name);
    return on;
  }

  contains(name: string): boolean {
    return this.set.has(name);
  }
}

class FakeElement {
  tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  style: Record<string, string> & { setProperty: (k: string, v: string) => void };
  className = '';
  textContent = '';
  src = '';
  title = '';
  draggable = false;
  width = 1;
  height = 1;
  clientWidth = 0;
  clientHeight = 0;
  private ctxStub: unknown = null;
  readonly classList: FakeClassList;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.classList = new FakeClassList('');
    const style = { setProperty: (k: string, v: string): void => { style[k] = v; } } as Record<string, unknown>;
    this.style = style as FakeElement['style'];
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  append(...nodes: unknown[]): void {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      const child = typeof node === 'string' ? FakeText.from(node) : (node as FakeElement);
      child.parent = this;
      this.children.push(child);
    }
  }

  appendChild(node: FakeElement): void {
    this.append(node);
  }

  removeChild(child: FakeElement): void {
    this.children = this.children.filter((c) => c !== child);
    child.parent = null;
  }

  remove(): void {
    this.parent?.removeChild(this);
  }

  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
    if (k === 'class') this.className = v;
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }

  getBoundingClientRect(): { bottom: number; width: number; height: number; left: number; top: number } {
    return { bottom: 0, width: 0, height: 0, left: 0, top: 0 };
  }

  getContext(): unknown {
    if (!this.ctxStub) this.ctxStub = makeCtx(this);
    return this.ctxStub;
  }

  toDataURL(): string {
    return 'data:,';
  }
}

class FakeText extends FakeElement {
  constructor(text: string) {
    super('#text');
    this.textContent = text;
  }

  static from(text: string): FakeElement {
    return new FakeText(text);
  }
}

type Ctx = Record<string | symbol, unknown>;

function noop(): void { /* 绘制替身 */ }

function makeCtx(canvas: FakeElement): CanvasRenderingContext2D {
  const store: Ctx = {
    canvas,
    measureText: () => ({ width: 10 }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createLinearGradient: () => ({ addColorStop: noop }),
  };
  return new Proxy(store, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return noop;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

export interface DomStub {
  /** 已排队的 requestAnimationFrame 回调；测试手动触发「一帧」 */
  rafCallbacks: FrameRequestCallback[];
  restore(): void;
}

export function installDomStub(): DomStub {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const setGlobal = (name: string, value: unknown): void => {
    if (!saved.has(name)) saved.set(name, name in g ? g[name] : undefined);
    g[name] = value;
  };

  const rafCallbacks: FrameRequestCallback[] = [];
  let nextRafId = 1;

  const body = new FakeElement('body');

  const documentStub = {
    body,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => FakeText.from(text),
    addEventListener: noop,
    removeEventListener: noop,
    getElementById: () => new FakeElement('div'),
  };

  const windowStub = {
    innerWidth: 800,
    innerHeight: 600,
    devicePixelRatio: 1,
    addEventListener: noop,
    removeEventListener: noop,
    requestAnimationFrame: (cb: FrameRequestCallback): number => {
      rafCallbacks.push(cb);
      return nextRafId++;
    },
    cancelAnimationFrame: noop,
    setInterval: (): number => 0,
    clearInterval: noop,
  };

  setGlobal('document', documentStub);
  setGlobal('window', windowStub);
  setGlobal('requestAnimationFrame', windowStub.requestAnimationFrame);
  setGlobal('cancelAnimationFrame', noop);

  return {
    rafCallbacks,
    restore(): void {
      for (const [name, old] of saved) {
        if (old === undefined) delete g[name];
        else g[name] = old;
      }
      saved.clear();
    },
  };
}
