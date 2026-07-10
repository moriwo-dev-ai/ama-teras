import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M29-2: 設定モーダルの外形固定(静的検証)。
 * タブ切替のたびにモーダルの大きさが変わる問題の回帰防止:
 * 外形は固定高(h-[85vh])+固定幅で、スクロールは中身側(overflow-y-auto)が担う。
 * どのタブを選んでも外形クラスは同一(タブ内容は overflow コンテナの中にしか描画されない)
 */

const source = (): string =>
  readFileSync(fileURLToPath(new URL('./SettingsPanel.tsx', import.meta.url)), 'utf8');

describe('M29-2: 設定モーダルの高さ固定', () => {
  it('モーダル外形は固定高(h-[85vh])で、max-h(内容依存の可変高)を使わない', () => {
    const src = source();
    expect(src).toContain('h-[85vh]');
    expect(src).not.toContain('max-h-[90vh]');
  });

  it('タブ内容は overflow-y-auto コンテナ内に描画される(中身がはみ出しても外形不動)', () => {
    const src = source();
    const shellIdx = src.indexOf('h-[85vh]');
    const overflowIdx = src.indexOf('overflow-y-auto', shellIdx);
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect(overflowIdx).toBeGreaterThan(shellIdx);
    // 全5タブの分岐が overflow コンテナより後(=中)にあること
    for (const tab of ["tab === 'basic'", "tab === 'models'", "tab === 'quality'", "tab === 'connect'", "tab === 'memory'"]) {
      expect(src.indexOf(tab), tab).toBeGreaterThan(overflowIdx);
    }
  });
});
