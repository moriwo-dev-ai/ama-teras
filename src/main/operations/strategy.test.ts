import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildKamuhakariPrompt, buildThreadContext, parseKamuhakariOutput } from './kamuhakari';
import { STRATEGY_MAX_CHARS, appendStrategyEntry, readStrategy } from './strategy';

/**
 * M103: 戦略台帳 — 神議の長期記憶。
 * 「毎回記憶喪失の参謀」問題への対処。壊れても運営を止めないことが最重要。
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'strategy-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('M103: strategy.md の読み書き', () => {
  it('初回読み込みで初期内容(ミッション・目標・台帳見出し)を作る', () => {
    const s = readStrategy(dir);
    expect(s).toContain('企業に囚われないAIエージェントの普及');
    expect(s).toContain('## 実行台帳');
    // 2回目は同じ内容(冪等)
    expect(readStrategy(dir)).toBe(s);
  });

  it('追記は新しいものが上・日付付き・ヘッダは不変', () => {
    readStrategy(dir);
    expect(appendStrategyEntry(dir, '初回の学び', new Date('2026-07-26T00:00:00Z'))).toBe(true);
    expect(appendStrategyEntry(dir, '2回目の学び', new Date('2026-07-27T00:00:00Z'))).toBe(true);
    const s = readFileSync(join(dir, 'strategy.md'), 'utf8');
    expect(s.indexOf('2026-07-27: 2回目の学び')).toBeLessThan(s.indexOf('2026-07-26: 初回の学び'));
    expect(s).toContain('## ミッション'); // ヘッダ保持
  });

  it('改行入りエントリは1行に潰し、500字で切る', () => {
    readStrategy(dir);
    appendStrategyEntry(dir, `複数\n行の\n学び${'x'.repeat(600)}`);
    const s = readFileSync(join(dir, 'strategy.md'), 'utf8');
    const line = s.split('\n').find((l) => l.includes('複数 行の 学び'))!;
    expect(line).toBeDefined();
    expect(line.length).toBeLessThan(520);
  });

  it('上限超過時は最古のエントリから捨てる(ヘッダは絶対に守る)', () => {
    readStrategy(dir);
    for (let i = 0; i < 100; i++) appendStrategyEntry(dir, `entry-${i} ${'y'.repeat(400)}`);
    const s = readFileSync(join(dir, 'strategy.md'), 'utf8');
    expect(s.length).toBeLessThanOrEqual(STRATEGY_MAX_CHARS + 600);
    expect(s).toContain('## ミッション');
    expect(s).toContain('entry-99'); // 最新は残る
    expect(s).not.toContain('entry-0 '); // 最古は落ちる
  });

  it('壊れたファイルでも例外を出さない(読めなければ空)', () => {
    // ディレクトリを渡す=readFileSyncが失敗する状況
    const bad = join(dir, 'strategy.md');
    rmSync(dir, { recursive: true, force: true });
    expect(readStrategy(join(bad, 'no-such-dir'))).toBe('');
    expect(appendStrategyEntry(join(bad, 'no-such-dir'), 'x')).toBe(false);
  });
});

describe('M103: プロンプトへの配線', () => {
  it('buildKamuhakariPrompt / buildThreadContext に戦略台帳が入る', () => {
    const p = buildKamuhakariPrompt({
      unread: [],
      history: [],
      postedDrafts: [],
      jobs: [],
      currentKeywords: [],
      project: { name: 'x', description: 'd' },
      strategy: '# 台帳\nミッションABC',
    });
    expect(p).toContain('戦略台帳');
    expect(p).toContain('ミッションABC');
    const c = buildThreadContext({
      history: [],
      jobs: [],
      postedDrafts: [],
      stagedDrafts: [],
      activeDraftTitles: [],
      evolutionJobs: [],
      strategy: 'ミッションXYZ',
    });
    expect(c).toContain('ミッションXYZ');
  });

  it('parseKamuhakariOutput が strategyAppend を拾う(無ければ undefined)', () => {
    const withIt = parseKamuhakariOutput('{"analysis":"a","paramChanges":[],"proposals":[],"strategyAppend":"学びメモ"}');
    expect(withIt?.strategyAppend).toBe('学びメモ');
    const without = parseKamuhakariOutput('{"analysis":"a","paramChanges":[],"proposals":[]}');
    expect(without?.strategyAppend).toBeUndefined();
  });
});
