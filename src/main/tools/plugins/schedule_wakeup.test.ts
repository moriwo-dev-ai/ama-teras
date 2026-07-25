import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types';
import scheduleWakeup from './schedule_wakeup';

/** M107: 自己ウェイクアップ予約ツール */

const ctx = (withWakeups: boolean, log: { delaySec: number; note: string }[]): ToolContext => ({
  cwd: 'C:/tmp',
  signal: new AbortController().signal,
  log: () => {},
  ...(withWakeups
    ? {
        wakeups: {
          schedule: (delaySec: number, note: string) => {
            log.push({ delaySec, note });
            return { id: 7, fireAtIso: '2026-07-26T00:00:00.000Z' };
          },
        },
      }
    : {}),
});

describe('M107: schedule_wakeup', () => {
  it('delaySecは60〜3600にクランプされ、予約IDと時刻を返す', async () => {
    const log: { delaySec: number; note: string }[] = [];
    const r1 = await scheduleWakeup.execute({ delaySec: 5, note: 'ビルド確認' }, ctx(true, log));
    expect(r1.isError).not.toBe(true);
    expect(log[0]).toEqual({ delaySec: 60, note: 'ビルド確認' });
    expect(r1.content).toContain('#7');
    expect(r1.content).toContain('クランプ');

    await scheduleWakeup.execute({ delaySec: 99999, note: 'x' }, ctx(true, log));
    expect(log[1]!.delaySec).toBe(3600);

    await scheduleWakeup.execute({ delaySec: 300, note: 'CI見る' }, ctx(true, log));
    expect(log[2]!.delaySec).toBe(300);
  });

  it('wakeups未注入(進化ジョブ等)では明示エラー', async () => {
    const r = await scheduleWakeup.execute({ delaySec: 300, note: 'x' }, ctx(false, []));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('この実行文脈では');
  });

  it('不正入力・空noteは拒否', async () => {
    const log: { delaySec: number; note: string }[] = [];
    expect((await scheduleWakeup.execute({ delaySec: 'x', note: 'y' }, ctx(true, log))).isError).toBe(true);
    expect((await scheduleWakeup.execute({ delaySec: 100, note: '   ' }, ctx(true, log))).isError).toBe(true);
    expect(log).toHaveLength(0);
  });
});
