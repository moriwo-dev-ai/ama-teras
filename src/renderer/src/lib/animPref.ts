/**
 * M16-4: アニメーション設定(renderer限定のUI好みなので localStorage 保存)。
 * <html data-anim="on|off"> を styles.css のセレクタが参照する。
 */
const ANIM_KEY = 'amateras-anim';

export function animEnabled(): boolean {
  try {
    return localStorage.getItem(ANIM_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function applyAnimPref(): void {
  document.documentElement.dataset.anim = animEnabled() ? 'on' : 'off';
}

export function setAnimEnabled(on: boolean): void {
  try {
    localStorage.setItem(ANIM_KEY, on ? 'on' : 'off');
  } catch {
    // localStorage不可でも属性は反映する
  }
  document.documentElement.dataset.anim = on ? 'on' : 'off';
}
