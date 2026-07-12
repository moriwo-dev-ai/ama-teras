import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, RunInfo, TsukuyomiEvent } from '../../shared/types';
import { TsukuyomiManager } from './manager';
import { finishedRuns, runLabel, speechFor } from './speaker';
import { sanitizeForPowerShell, speakWithPowerShell } from './voiceFallback';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-speak-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (id: string, title: string): RunInfo => ({
  conversationId: id,
  title,
  workspace: 'C:/dev/x',
  sessionId: id,
  startedAt: 0,
});

describe('M42-2(TUKU-yomi) 口: 文言テーブル(短く・控えめに・月らしく)', () => {
  it('実行完了と承認待ちの文言を固定する', () => {
    expect(speechFor({ kind: 'runs-finished', label: 'ビルド' })).toBe('ビルド が終わったよ');
    expect(speechFor({ kind: 'runs-finished', label: '' })).toBe('作業が終わったよ');
    expect(speechFor({ kind: 'approval-waiting', count: 1 })).toBe('承認待ちが1件あるよ');
    expect(speechFor({ kind: 'approval-waiting', count: 3 })).toBe('承認待ちが3件たまってるよ');
    // 0件で話しかけない(黙るべき時を知る)
    expect(speechFor({ kind: 'approval-waiting', count: 0 })).toBeNull();
    expect(speechFor({ kind: 'welcome-back', whileAway: [] })).toBe('おかえり');
    expect(speechFor({ kind: 'welcome-back', whileAway: ['ビルドが終わってた'] })).toBe(
      'おかえり。留守中にビルドが終わってた',
    );
    expect(speechFor({ kind: 'welcome-back', whileAway: ['a', 'b', 'c'] })).toBe('おかえり。留守中にa(ほか2件)');
  });

  it('ランの差分: 消えたもの=完了。開始・進行では喋らない', () => {
    const a = run('1', 'ビルド');
    const b = run('2', 'テスト');
    expect(finishedRuns([a, b], [b])).toEqual([a]);
    expect(finishedRuns([a], [a, b])).toEqual([]); // 開始では何も返さない
    expect(runLabel(run('1', 'a'.repeat(40)))).toHaveLength(25); // 24文字+…
  });
});

describe('M42-2(TUKU-yomi) 口: 発話ソースは予算を必ず通る', () => {
  const make = (over: Record<string, unknown> = {}, now = new Date('2026-07-12T12:00:00')) => {
    const events: TsukuyomiEvent[] = [];
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () =>
        ({ tsukuyomi: { enabled: true, voiceOutput: true, interruptBudgetPerDay: 1, ...over } }) as AppConfig,
      hasOwnerKey: () => true,
      emit: (e) => events.push(e),
      nowFn: () => now,
    });
    return { manager, spoken: () => events.filter((e) => e.type === 'speak').map((e) => (e as { text: string }).text) };
  };

  it('ランが終わったら喋る。開始では喋らない', () => {
    const { manager, spoken } = make();
    manager.onRunsChanged([run('1', 'ビルド')]); // 開始
    expect(spoken()).toEqual([]);
    manager.onRunsChanged([]); // 完了
    expect(spoken()).toEqual(['ビルド が終わったよ']);
  });

  it('承認待ちは件数が変わった時だけ。同じ件数で二度言わない', () => {
    const { manager, spoken } = make({ interruptBudgetPerDay: 5 });
    manager.onApprovalWaiting(1);
    manager.onApprovalWaiting(1);
    expect(spoken()).toEqual(['承認待ちが1件あるよ']);
  });

  it('静音時間は黙る(予算が残っていても)', () => {
    const { manager, spoken } = make({}, new Date('2026-07-12T23:30:00'));
    manager.onRunsChanged([run('1', 'ビルド')]);
    manager.onRunsChanged([]);
    expect(spoken()).toEqual([]);
  });

  it('予算を使い切ったら黙る', () => {
    const { manager, spoken } = make({ interruptBudgetPerDay: 1 });
    manager.onRunsChanged([run('1', 'A'), run('2', 'B')]);
    manager.onRunsChanged([run('2', 'B')]); // A完了 → 1回目
    manager.onRunsChanged([]); // B完了 → 予算切れで黙る
    expect(spoken()).toEqual(['A が終わったよ']);
  });
});

describe('M42-2(TUKU-yomi) 口: OS音声フォールバック(APIには何も送らない)', () => {
  it('コマンド組み立ての事故防止: 引用符・改行を落とす', () => {
    expect(sanitizeForPowerShell("こんにちは'; rm -rf /; '")).not.toContain("'");
    expect(sanitizeForPowerShell('改行\nあり')).toBe('改行 あり');
    expect(sanitizeForPowerShell('a'.repeat(500))).toHaveLength(300);
  });

  it('System.Speech を spawn する(実発話はテストしない)', async () => {
    const spawner = vi.fn(async (_c: string, _a: string[]) => true);
    const ok = await speakWithPowerShell('ビルドが終わったよ', spawner);
    if (process.platform === 'win32') {
      expect(ok).toBe(true);
      expect(spawner).toHaveBeenCalledWith('powershell', expect.arrayContaining(['-NoProfile']));
      const args = spawner.mock.calls[0]?.[1] as string[] | undefined;
      expect(String(args)).toContain('System.Speech');
    } else {
      expect(ok).toBe(false); // win32以外では黙って何もしない
    }
  });

  it('空文字は喋らない', async () => {
    const spawner = vi.fn(async (_c: string, _a: string[]) => true);
    expect(await speakWithPowerShell('   ', spawner)).toBe(false);
    expect(spawner).not.toHaveBeenCalled();
  });
});
