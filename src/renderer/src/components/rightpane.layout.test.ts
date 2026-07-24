import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * M29-3: 右ペイン(進化/Debug)の狭幅レスポンシブ(静的検証)。
 * 実起動スクリーンショットの代替として、崩れの原因だった構造をソースで固定する:
 * - 横並びフォーム行は flex-wrap(狭幅では折り返し、縦書き化・横スクロールを出さない)
 * - ボタンは whitespace-nowrap(文字の縦積み防止)
 * - 可変幅入力は min-w + flex-1、truncate する flex 子は min-w-0
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('M29-3: 進化タブのレスポンシブ構造', () => {
  const src = (): string => read('./Evolution/EvolutionPanel.tsx');

  it('ジョブ起動フォーム行は flex-wrap で折り返す', () => {
    expect(src()).toContain('flex flex-wrap items-center gap-2');
  });

  it('「ジョブ起動」「インポート」ボタンは whitespace-nowrap(縦書き化防止)', () => {
    const s = src();
    // M100-2: 文言はi18n辞書へ移動したため、キー参照を目印にする
    const jobBtn = s.indexOf("t('evo.enqueue')");
    const importBtn = s.indexOf("t('evo.import')");
    expect(jobBtn).toBeGreaterThan(0);
    expect(importBtn).toBeGreaterThan(0);
    // 各ボタンの className(直前の範囲)に whitespace-nowrap があること
    expect(s.slice(jobBtn - 600, jobBtn)).toContain('whitespace-nowrap');
    // インポートボタンは className とラベルの間に長い onClick が挟まるため窓を広めに取る
    expect(s.slice(importBtn - 1500, importBtn)).toContain('whitespace-nowrap');
  });

  it('ジョブ説明は min-w-0 flex-1 truncate(はみ出しの根本原因の固定)', () => {
    expect(src()).toContain('min-w-0 flex-1 truncate');
  });
});

describe('M29-3: Debugタブのレスポンシブ構造', () => {
  const src = (): string => read('./Debug/ToolDebugPanel.tsx');

  it('ヘッダ行(ツール選択・実行・自動承認)は flex-wrap で折り返す', () => {
    const s = src();
    expect(s).toContain('flex flex-wrap items-center gap-x-3');
    // 自動承認チェック行も折り返し可能
    expect(s).toContain('ml-auto flex flex-wrap items-center gap-2');
  });

  it('ツール選択セレクトは min-w-0 で縮み、横スクロールを出さない', () => {
    expect(src()).toContain('min-w-0 max-w-full flex-1');
  });

  it('実行・再読込ボタンは whitespace-nowrap', () => {
    const s = src();
    const runBtn = s.indexOf("running ? '実行中…' : '実行'");
    expect(s.slice(runBtn - 600, runBtn)).toContain('whitespace-nowrap');
    const reloadBtn = s.indexOf('プラグイン再読込');
    expect(s.slice(reloadBtn - 400, reloadBtn)).toContain('whitespace-nowrap');
  });
});
