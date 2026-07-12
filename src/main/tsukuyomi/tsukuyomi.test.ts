import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUS_CHANNELS, EventBus, LOCAL_ONLY_CHANNELS, type BusChannel } from '../core/events';
import { ConfigStore, parseTsukuyomiConfig } from '../config';
import type { AppConfig, TsukuyomiEvent } from '../../shared/types';
import {
  canInterrupt,
  canSendFrame,
  emptyState,
  framesLeftThisHour,
  interruptsLeft,
  isQuietHour,
  resetIfNewDay,
  spend,
  spendFrame,
} from './budget';
import { TsukuyomiManager } from './manager';
import { OBSERVATION_TTL_DAYS, TsukiNoCho } from './tsukiNoCho';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsukuyomi-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const BASE: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

describe('M42(TUKU-yomi) 鉄則4: オーナー機体限定(鍵ファイルが門)', () => {
  it('鍵が無ければ enabled は保存時に false へ落ちる(UIの出し分けだけに頼らない)', () => {
    const file = join(dir, 'config.json');
    const noKey = new ConfigStore(file, () => false);
    noKey.set({ ...BASE, tsukuyomi: { enabled: true, camera: true, ears: true, voiceOutput: true } });

    const saved = new ConfigStore(file, () => false).get().tsukuyomi;
    expect(saved?.enabled).toBe(false);
    // 目・耳・口も道連れ(ONのまま残さない)
    expect(saved?.camera).toBe(false);
    expect(saved?.ears).toBe(false);
    expect(saved?.voiceOutput).toBe(false);
  });

  it('鍵があれば有効にできる。設定ファイルに直接 true を書いても鍵が無ければ読み込みで落ちる', () => {
    const file = join(dir, 'config.json');
    const withKey = new ConfigStore(file, () => true);
    withKey.set({ ...BASE, tsukuyomi: { enabled: true, camera: true } });
    expect(new ConfigStore(file, () => true).get().tsukuyomi?.enabled).toBe(true);

    // 鍵を失った機体(= 配布先の他人のPC)では読み込み時点で false
    expect(new ConfigStore(file, () => false).get().tsukuyomi?.enabled).toBe(false);
  });

  it('ConfigStore の第2引数を省略した既存の呼び出しは「鍵なし」= 月読は常にOFF', () => {
    const file = join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ ...BASE, tsukuyomi: { enabled: true } }), 'utf8');
    expect(new ConfigStore(file).get().tsukuyomi?.enabled).toBe(false);
  });

  it('parse: 壊れた形は undefined(=OFF)。映像理解はカメラONが前提', () => {
    expect(parseTsukuyomiConfig(null)).toBeUndefined();
    expect(parseTsukuyomiConfig({ enabled: 'yes' })).toBeUndefined();
    expect(parseTsukuyomiConfig({ enabled: true, quietHours: { start: '25:00', end: '07:00' } })?.quietHours).toBeUndefined();
    // camera=false のまま理解だけONにはできない
    expect(parseTsukuyomiConfig({ enabled: true, cameraUnderstanding: true })?.cameraUnderstanding).toBe(false);
    expect(parseTsukuyomiConfig({ enabled: true, camera: true, cameraUnderstanding: true })?.cameraUnderstanding).toBe(true);
  });
});

describe('M42(TUKU-yomi) 鉄則4: 帳と発話はスマホへ漏らさない', () => {
  it('tsukuyomi:event は SSE中継の対象(BUS_CHANNELS)に入っていない', () => {
    expect(BUS_CHANNELS).not.toContain('tsukuyomi:event' as BusChannel);
    expect(LOCAL_ONLY_CHANNELS).toContain('tsukuyomi:event' as BusChannel);
  });

  it('subscribeAll(=SSEが使う購読)には tsukuyomi:event が流れない', () => {
    const bus = new EventBus();
    const relayed: string[] = [];
    bus.subscribeAll((channel) => relayed.push(channel));

    const local: TsukuyomiEvent[] = [];
    bus.subscribe('tsukuyomi:event', (e) => local.push(e));

    bus.publish('tsukuyomi:event', { type: 'speak', text: '秘密の一言' });
    bus.publish('runs:changed', []);

    expect(local).toHaveLength(1); // デスクトップには届く
    expect(relayed).toEqual(['runs:changed']); // スマホへは runs だけ
  });
});

describe('M42(TUKU-yomi) 月の帳(残るのは一文だけ・観察は7日で忘れる)', () => {
  const path = (): string => join(dir, 'tsuki-no-cho.jsonl');

  it('追記・一覧・完了。observation には完了を付けない(観察は完了する種類ではない)', () => {
    const cho = new TsukiNoCho(path());
    const todo = cho.add({ kind: 'todo', text: 'レビューの資料を作る', source: 'manual' });
    const obs = cho.add({ kind: 'observation', text: '10:42 離席 → 11:03 戻り', source: 'camera' });

    expect(cho.list()).toHaveLength(2);
    expect(cho.setDone(todo.id, true)?.done).toBe(true);
    expect(cho.setDone(obs.id, true)).toBeNull();
    expect(cho.list().find((e) => e.id === todo.id)?.done).toBe(true);
  });

  it('忘却: observation は7日で消える。約束・決定・ToDo は消えない', () => {
    let now = new Date('2026-07-12T10:00:00');
    const cho = new TsukiNoCho(path(), () => now);
    cho.add({ kind: 'observation', text: '古い観察', source: 'camera' });
    cho.add({ kind: 'promise', text: '来週レビューをやると言った', source: 'voice' });

    now = new Date(now.getTime() + (OBSERVATION_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(cho.prune()).toBe(1);
    const left = cho.list();
    expect(left).toHaveLength(1);
    expect(left[0]?.kind).toBe('promise'); // 約束は覚えている
  });

  it('壊れた行(追記の途中で切れた行)があっても読める', () => {
    const cho = new TsukiNoCho(path());
    cho.add({ kind: 'todo', text: '正しい行', source: 'manual' });
    writeFileSync(path(), `${readFileSync(path(), 'utf8')}{"id":"broken","tex`, 'utf8');
    expect(cho.list()).toHaveLength(1);
  });
});

describe('M42(TUKU-yomi) 鉄則3: 割り込み予算(黙るべき時を知る)', () => {
  const cfg = { enabled: true, interruptBudgetPerDay: 2, quietHours: { start: '23:00', end: '07:00' } };

  it('静音時間は日付を跨いでも正しく判定する(23:00→07:00)', () => {
    expect(isQuietHour(new Date('2026-07-12T23:30:00'), cfg)).toBe(true);
    expect(isQuietHour(new Date('2026-07-13T03:00:00'), cfg)).toBe(true);
    expect(isQuietHour(new Date('2026-07-13T06:59:00'), cfg)).toBe(true);
    expect(isQuietHour(new Date('2026-07-13T07:00:00'), cfg)).toBe(false);
    expect(isQuietHour(new Date('2026-07-13T12:00:00'), cfg)).toBe(false);
    // 跨がない範囲も正しく
    expect(isQuietHour(new Date('2026-07-13T03:00:00'), { enabled: true, quietHours: { start: '01:00', end: '05:00' } })).toBe(true);
  });

  it('予算を使い切ったら黙る。日が変わると戻る', () => {
    const noon = new Date('2026-07-12T12:00:00');
    let state = emptyState(noon);
    expect(canInterrupt(state, cfg, noon)).toBe(true);
    state = spend(state, noon);
    state = spend(state, noon);
    expect(interruptsLeft(state, cfg, noon)).toBe(0);
    expect(canInterrupt(state, cfg, noon)).toBe(false);

    const nextDay = new Date('2026-07-13T09:00:00');
    expect(canInterrupt(state, cfg, nextDay)).toBe(true);
    expect(resetIfNewDay(state, nextDay).interruptsSpent).toBe(0);
  });

  it('静音時間は予算が残っていても喋らない', () => {
    const night = new Date('2026-07-12T23:30:00');
    expect(canInterrupt(emptyState(night), cfg, night)).toBe(false);
  });

  it('フレーム送信は時間・日の二重上限。1時間の窓は滑走する', () => {
    const cfgFrames = { enabled: true, framesPerHour: 2, framesPerDay: 3 };
    const t0 = new Date('2026-07-12T12:00:00');
    let state = emptyState(t0);
    state = spendFrame(state, t0);
    state = spendFrame(state, new Date('2026-07-12T12:10:00'));
    expect(canSendFrame(state, cfgFrames, new Date('2026-07-12T12:20:00'))).toBe(false); // 時間上限

    // 1時間経てば時間枠は空く
    const later = new Date('2026-07-12T13:15:00');
    expect(framesLeftThisHour(state, cfgFrames, later)).toBe(2);
    expect(canSendFrame(state, cfgFrames, later)).toBe(true);

    state = spendFrame(state, later);
    expect(canSendFrame(state, cfgFrames, later)).toBe(false); // 日上限(3枚)に到達
  });
});

describe('M42(TUKU-yomi) マネージャ', () => {
  const make = (over: Partial<AppConfig['tsukuyomi']> = {}, hasKey = true) => {
    const events: TsukuyomiEvent[] = [];
    const manager = new TsukuyomiManager({
      userDataDir: dir,
      getConfig: () =>
        ({ ...BASE, tsukuyomi: { enabled: true, voiceOutput: true, interruptBudgetPerDay: 1, ...over } }) as AppConfig,
      hasOwnerKey: () => hasKey,
      emit: (e) => events.push(e),
      nowFn: () => new Date('2026-07-12T12:00:00'),
    });
    return { manager, events };
  };

  it('鍵が無ければ帳を読み書きしない(存在しないのと同じ)', () => {
    const { manager } = make({}, false);
    expect(manager.add({ kind: 'todo', text: 'x', source: 'manual' })).toBeNull();
    expect(manager.list()).toEqual([]);
    expect(manager.status().enabled).toBe(false);
    expect(manager.status().ownerKeyPresent).toBe(false);
  });

  it('自発的な発話は予算を消費し、切れたら黙る', () => {
    const { manager, events } = make();
    expect(manager.trySpeak('ビルド終わったよ')).toBe(true);
    expect(manager.trySpeak('もう一回')).toBe(false); // 予算1回
    expect(events.filter((e) => e.type === 'speak')).toHaveLength(1);
    expect(manager.status().interruptsLeft).toBe(0);
  });

  it('ユーザーが押したボタンの発話は予算を使わない(鉄則3)', () => {
    const { manager } = make();
    expect(manager.speakWithoutBudget('試し')).toBe(true);
    expect(manager.speakWithoutBudget('試し')).toBe(true);
    expect(manager.status().interruptsLeft).toBe(1); // 減らない
  });

  it('口がOFFなら speak イベント自体を出さない', () => {
    const { manager, events } = make({ voiceOutput: false });
    expect(manager.trySpeak('黙る')).toBe(false);
    expect(events.filter((e) => e.type === 'speak')).toHaveLength(0);
  });

  it('鉄則10: stop() 後は復活せず、state.json も書かない', () => {
    vi.useFakeTimers();
    try {
      const { manager } = make();
      manager.start();
      manager.stop();
      manager.start(); // 使い捨て(復活しない)
      vi.advanceTimersByTime(3 * 60 * 60 * 1000);
      // 停止済みインスタンスは書き込まない
      expect(manager.trySpeak('幽霊')).toBe(true); // emit自体はするが…
      const statePath = join(dir, 'tsukuyomi', 'state.json');
      let written = true;
      try {
        readFileSync(statePath, 'utf8');
      } catch {
        written = false;
      }
      expect(written).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
