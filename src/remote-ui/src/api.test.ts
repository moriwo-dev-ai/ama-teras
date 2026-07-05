import { describe, expect, it } from 'vitest';
import { extractTokenFromHash } from './api';

/** M15.1: PWA(ホーム画面)起動でのトークン抽出を固定する */

const TOKEN = 'a'.repeat(64);

describe('extractTokenFromHash', () => {
  it('標準形 #t=<64hex> を抽出する', () => {
    expect(extractTokenFromHash(`#t=${TOKEN}`)).toBe(TOKEN);
  });

  it('前後に別要素が付いていても抽出できる(iOSホーム画面起動の揺れ対策)', () => {
    expect(extractTokenFromHash(`#foo=1&t=${TOKEN}`)).toBe(TOKEN);
    expect(extractTokenFromHash(`#t=${TOKEN}&utm=x`)).toBe(TOKEN);
    expect(extractTokenFromHash(`?t=${TOKEN}`)).toBe(TOKEN);
  });

  it('不正な形式は null(長さ違い・16進以外・部分一致の巻き込み防止)', () => {
    expect(extractTokenFromHash('')).toBeNull();
    expect(extractTokenFromHash('#t=short')).toBeNull();
    expect(extractTokenFromHash(`#t=${'z'.repeat(64)}`)).toBeNull();
    expect(extractTokenFromHash(`#t=${TOKEN}ff`)).toBeNull(); // 66文字は不正
    expect(extractTokenFromHash(`#not=${TOKEN}`)).toBeNull(); // t=ではない
  });
});
