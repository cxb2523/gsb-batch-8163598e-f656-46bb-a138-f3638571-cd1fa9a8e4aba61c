/**
 * 场景级精灵缓存：同一作用域内按键复用，切换作用域整体失效，
 * 释放时清空全部条目。
 *
 * 与画布绘制解耦，因此可以在 Node 测试里直接驱动"切换 / 复用 / 释放"的
 * 生命周期，而不需要真实 Canvas。
 */
export interface SpriteCacheStats {
  /** 当前作用域；null = 尚未绑定场景 */
  scope: string | null;
  /** 当前缓存的条目数 */
  entries: number;
  /** 自上次 clear 以来的惰性构建次数 */
  builds: number;
  /** 自上次 clear 以来的缓存命中次数 */
  hits: number;
}

export class SpriteCache<T> {
  private readonly entries = new Map<string, T>();
  private currentScope: string | null = null;
  private buildCount = 0;
  private hitCount = 0;

  constructor(private readonly create: (key: string) => T) {}

  get scope(): string | null {
    return this.currentScope;
  }

  /**
   * 进入场景作用域。作用域变化时丢弃全部旧条目 —— 与旧场景绑定的精灵
   * 不再可用；作用域不变时保持缓存，保证同一场景重复绘制仍然命中。
   * @returns 作用域是否发生变化（即是否发生了失效）
   */
  enterScope(scope: string): boolean {
    if (scope === this.currentScope) return false;
    this.currentScope = scope;
    this.entries.clear();
    return true;
  }

  /** 取精灵：同作用域内命中缓存，缺失时才惰性构建。 */
  get(key: string): T {
    if (this.entries.has(key)) {
      this.hitCount += 1;
      return this.entries.get(key) as T;
    }
    const sprite = this.create(key);
    this.buildCount += 1;
    this.entries.set(key, sprite);
    return sprite;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * 删除满足条件的条目（用于淘汰过期外观等细分场景），
   * 返回被删除的 key，方便调用方同步清理派生缓存（dataURL 等）。
   */
  prune(predicate: (key: string) => boolean): string[] {
    const removed: string[] = [];
    for (const key of this.entries.keys()) {
      if (predicate(key)) {
        this.entries.delete(key);
        removed.push(key);
      }
    }
    return removed;
  }

  /** 释放全部条目与作用域（返回标题 / 销毁 App 时调用）。之后可重新进入游戏。 */
  clear(): void {
    this.entries.clear();
    this.currentScope = null;
    this.buildCount = 0;
    this.hitCount = 0;
  }

  stats(): SpriteCacheStats {
    return {
      scope: this.currentScope,
      entries: this.entries.size,
      builds: this.buildCount,
      hits: this.hitCount,
    };
  }
}
