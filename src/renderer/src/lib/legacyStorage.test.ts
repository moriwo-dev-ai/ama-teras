import { describe, expect, it } from 'vitest';
import { migrateLegacyLocalStorage } from './legacyStorage';

/** M27-7: localStorage キーの旧称(mycodex-*)一回きり移行 */

function fakeStorage(initial: Record<string, string>): {
  store: Map<string, string>;
  api: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
} {
  const store = new Map(Object.entries(initial));
  return {
    store,
    api: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    },
  };
}

describe('migrateLegacyLocalStorage', () => {
  it('旧キーの値を新キーへコピーし、旧キーを消す', () => {
    const { store, api } = fakeStorage({ 'mycodex-anim': 'off', 'mycodex-pane-left': '300' });
    migrateLegacyLocalStorage(api);
    expect(store.get('amateras-anim')).toBe('off');
    expect(store.get('amateras-pane-left')).toBe('300');
    expect(store.has('mycodex-anim')).toBe(false);
    expect(store.has('mycodex-pane-left')).toBe(false);
  });

  it('新キーが既にあれば上書きしない(新しい方を正とする)。旧キーだけ消える', () => {
    const { store, api } = fakeStorage({ 'mycodex-anim': 'off', 'amateras-anim': 'on' });
    migrateLegacyLocalStorage(api);
    expect(store.get('amateras-anim')).toBe('on');
    expect(store.has('mycodex-anim')).toBe(false);
  });

  it('旧キーが無ければ何もしない。storage未提供(非ブラウザ)でも例外にしない', () => {
    const { store, api } = fakeStorage({});
    migrateLegacyLocalStorage(api);
    expect(store.size).toBe(0);
    expect(() => migrateLegacyLocalStorage(undefined)).not.toThrow();
  });
});
