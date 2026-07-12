import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig, RunInfo, TsukuyomiEvent } from '../../shared/types';
import {
  AWAY_AFTER_STILL_SAMPLES,
  frameDiff,
  initialPresence,
  MOTION_THRESHOLD,
  presenceText,
  RETURN_MOTION_IN_WINDOW,
  RETURN_WINDOW,
  stepPresence,
  type PresenceState,
} from '../../shared/tsukuyomi';
import { TsukuyomiManager } from './manager';

/**
 * 在席検知の判定は renderer 側の純関数だが、**判定ロジックはテストで固定する**
 * (カメラ実機はテストしない。ここで見るのは「離席・戻りをどう決めるか」だけ)
 */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsuku-presence-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const still = new Uint8ClampedArray([100, 100, 100, 100]);
const moved = new Uint8ClampedArray([100, 100, 100, 200]);

describe('M42-3(TUKU-yomi) 目①: 在席検知(ローカル完結・APIに何も送らない)', () => {
  it('フレーム差分: 同じなら0、解像度が変わったら1(=動きあり扱い)', () => {
    expect(frameDiff(still, still)).toBe(0);
    expect(frameDiff(still, moved)).toBeGreaterThan(MOTION_THRESHOLD);
    expect(frameDiff(new Uint8ClampedArray(), still)).toBe(1);
    expect(frameDiff(still, new Uint8ClampedArray([1, 2]))).toBe(1);
  });

  it('連続して静止したら離席。一瞬の静止では離席にしない', () => {
    let state = initialPresence();
    for (let i = 0; i < AWAY_AFTER_STILL_SAMPLES - 1; i++) {
      const r = stepPresence(state, 0);
      state = r.state;
      expect(r.event).toBeNull(); // まだ離席と言わない
    }
    const last = stepPresence(state, 0);
    expect(last.event).toBe('away');
    expect(last.state.presence).toBe('away');
  });

  /**
   * 実機で2回起きた誤爆(2026-07-12): 「大きな動き1回」でも「連続2回」でも、
   * **目の前を通り過ぎただけ**で「おかえり」と言ってしまった。
   * 直近18秒のうち4回以上動いた時だけ戻す(滑走窓)
   */
  it('通り過ぎ(18秒の窓で動き2回)では戻らない', () => {
    let state: PresenceState = { presence: 'away', stillCount: 30, recent: [] };
    // 通行人: 6秒間だけ大きく動いて、あとは無人のノイズ
    for (const diff of [0.05, 0.04, 0.004, 0.003, 0.005, 0.004]) {
      const r = stepPresence(state, diff);
      expect(r.event).toBeNull(); // 一度も「おかえり」と言わない
      state = r.state;
    }
    expect(state.presence).toBe('away');
  });

  it('席に戻る(窓の中で4回以上動く)なら戻り。座って静止する瞬間があってもよい', () => {
    let state: PresenceState = { presence: 'away', stillCount: 30, recent: [] };
    const events: (string | null)[] = [];
    // 着席: 動く→動く→一瞬静止→動く→動く(座って落ち着くまで)
    for (const diff of [0.04, 0.03, 0.004, 0.02, 0.03]) {
      const r = stepPresence(state, diff);
      events.push(r.event);
      state = r.state;
    }
    expect(RETURN_MOTION_IN_WINDOW).toBe(4);
    expect(RETURN_WINDOW).toBe(6);
    expect(events).toContain('returned');
    expect(state.presence).toBe('present');
  });

  /**
   * 実カメラで測った値(2026-07-12)。判定が現実に合っていることを固定する —
   * 人が座って静止している時でも 0.0045 が出るため、旧しきい値(0.02)では戻れなかった
   */
  it('実測値で固定: 静止(0.0045/0.0091)は動きとみなさない。0.018以上は動き', () => {
    const away: PresenceState = { presence: 'away', stillCount: 30, recent: [] };
    expect(stepPresence(away, 0.0045).state.recent).toEqual([false]); // 無人のノイズ
    expect(stepPresence(away, 0.0091).state.recent).toEqual([false]);
    expect(stepPresence(away, 0.018).state.recent).toEqual([true]); // 人が動いた
    expect(stepPresence(away, 0.0358).state.recent).toEqual([true]);
  });

  it('帳に書く一文は時刻と出来事だけ(映像も人物も残さない)', () => {
    expect(presenceText('away', new Date('2026-07-12T10:42:00'))).toBe('10:42 離席');
    expect(presenceText('returned', new Date('2026-07-12T11:03:00'))).toBe('11:03 戻り');
  });
});

describe('M42-3(TUKU-yomi) 目①: 留守中の出来事は戻ってから伝える', () => {
  const run = (id: string, title: string): RunInfo => ({
    conversationId: id,
    title,
    workspace: 'C:/x',
    sessionId: id,
    startedAt: 0,
  });

  const make = () => {
    const events: TsukuyomiEvent[] = [];
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () =>
        ({ tsukuyomi: { enabled: true, voiceOutput: true, camera: true, interruptBudgetPerDay: 5 } }) as AppConfig,
      hasOwnerKey: () => true,
      emit: (e) => events.push(e),
      nowFn: () => new Date('2026-07-12T12:00:00'),
    });
    return {
      manager,
      spoken: () => events.filter((e) => e.type === 'speak').map((e) => (e as { text: string }).text),
    };
  };

  it('離席中に終わったランは喋らない。戻ってきたら「おかえり。留守中に〜」', () => {
    const { manager, spoken } = make();
    manager.onRunsChanged([run('1', 'ビルド')]);
    manager.onPresence('away', '10:42 離席');
    manager.onRunsChanged([]); // 留守中に完了 → 喋らない(居ないので)
    expect(spoken()).toEqual([]);

    manager.onPresence('returned', '11:03 戻り');
    expect(spoken()).toEqual(['おかえり。留守中にビルドが終わってた']);
  });

  it('離席・戻りは帳に observation として残る(7日で忘れる)', () => {
    const { manager } = make();
    manager.onPresence('away', '10:42 離席');
    manager.onPresence('returned', '11:03 戻り');
    const entries = manager.list();
    expect(entries.map((e) => e.text)).toEqual(['10:42 離席', '11:03 戻り']);
    expect(entries.every((e) => e.kind === 'observation' && e.source === 'camera')).toBe(true);
  });

  it('カメラOFFなら在席イベントを受けても何もしない', () => {
    const events: TsukuyomiEvent[] = [];
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () => ({ tsukuyomi: { enabled: true, camera: false } }) as AppConfig,
      hasOwnerKey: () => true,
      emit: (e) => events.push(e),
    });
    manager.onPresence('away', '10:42 離席');
    expect(manager.list()).toEqual([]);
    expect(events).toEqual([]);
  });
});
