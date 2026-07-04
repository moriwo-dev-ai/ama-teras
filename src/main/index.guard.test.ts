import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M12-0 回帰ガード: 多重起動ガード(requestSingleInstanceLock)がスモークモード
 * (MYCODEX_SMOKE=1)ではロックを取らないことを固定する。
 * 進化ゲートのスモークテストは稼働中のAと並行してheadless起動するため、
 * スモークがロックを取ると進化パイプラインが壊れる。
 * これらのテストが落ちる変更は、理由の提示とユーザー承認なしに入れてはならない。
 */

const source = (): string =>
  readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

describe('多重起動ガード(M12-0で不変)', () => {
  it('ロック取得はスモークモード判定で迂回される(ソース・トリップワイヤ)', () => {
    const src = source();
    // smokeMode のときは requestSingleInstanceLock 自体を評価しない式を固定
    expect(src).toContain("smokeMode ? true : app.requestSingleInstanceLock()");
    expect(src).toContain("process.env['MYCODEX_SMOKE'] === '1'");
  });

  it('requestSingleInstanceLock の呼び出し箇所は1箇所だけ', () => {
    const calls = source().match(/requestSingleInstanceLock/g) ?? [];
    // コメント・テスト名を除き index.ts 内の実呼び出しが増えたらこのテストで気付かせる
    expect(calls.length).toBe(1);
  });

  it('second-instance ハンドラは非スモーク時のみ登録される', () => {
    const src = source();
    expect(src).toContain("app.on('second-instance'");
    // second-instance 登録が if (!smokeMode) ブロック内にあることを近傍テキストで固定
    const guardIdx = src.indexOf('if (!smokeMode) {');
    const handlerIdx = src.indexOf("app.on('second-instance'");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(handlerIdx).toBeGreaterThan(guardIdx);
  });

  it('ロックが取れなければ quit、取れたときだけ whenReady で起動する', () => {
    const src = source();
    const quitIdx = src.indexOf('if (!gotSingleInstanceLock) {');
    expect(quitIdx).toBeGreaterThanOrEqual(0);
    expect(src.indexOf('app.quit()', quitIdx)).toBeGreaterThan(quitIdx);
    // whenReady が else 側(ロック取得済み)にあること
    expect(src.indexOf('app.whenReady()')).toBeGreaterThan(quitIdx);
  });
});
