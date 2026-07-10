/**
 * M27-7(旧称一掃): localStorage キーの mycodex-* → amateras-* 一回きり移行。
 * 旧キーは移行元参照としてここにだけ残す(値をコピーして旧キーを消す)。
 * 起動時(main.tsx)に各 Pref の読み出しより前に呼ぶこと
 */

const RENAMES: [oldKey: string, newKey: string][] = [
  ['mycodex-pane-left', 'amateras-pane-left'],
  ['mycodex-pane-right', 'amateras-pane-right'],
  ['mycodex-anim', 'amateras-anim'],
];

export function migrateLegacyLocalStorage(
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = globalThis.localStorage,
): void {
  if (storage === undefined) return;
  for (const [oldKey, newKey] of RENAMES) {
    try {
      const v = storage.getItem(oldKey);
      if (v === null) continue;
      if (storage.getItem(newKey) === null) storage.setItem(newKey, v);
      storage.removeItem(oldKey);
    } catch {
      // localStorage 不可でも起動を止めない
    }
  }
}
