import { describe, expect, it, vi } from 'vitest';
import type { WorldPushPayload } from '../../shared/types';
import { EventBus } from '../core/events';
import { WorldManager } from './manager';

/**
 * M115: 世界ブリッジの中核挙動。
 * - 接続判定は最終受信からの経過時間
 * - act はバスへ押し出し、ack で解決・タイムアウトで失敗を返す
 * - チャットはハンドラへ渡り、ログに蓄積される
 */

function setup(nowRef: { t: number }, ackTimeoutMs = 500) {
  const bus = new EventBus();
  const mgr = new WorldManager(bus, () => nowRef.t, ackTimeoutMs);
  const pushed: WorldPushPayload[] = [];
  bus.subscribe('world:event', (p) => pushed.push(p));
  return { bus, mgr, pushed };
}

describe('WorldManager', () => {
  it('未受信なら未接続、受信後は接続扱い、30秒経過で未接続へ戻る', () => {
    const now = { t: 1000 };
    const { mgr } = setup(now);
    expect(mgr.isConnected()).toBe(false);
    mgr.onPageEvent({ kind: 'hello' });
    expect(mgr.isConnected()).toBe(true);
    now.t += 31_000;
    expect(mgr.isConnected()).toBe(false);
  });

  it('未接続の act は即座に失敗を返す(バスへ流さない)', async () => {
    const now = { t: 0 };
    const { mgr, pushed } = setup(now);
    const r = await mgr.act([{ type: 'say', text: 'hi' }]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('未接続');
    expect(pushed).toHaveLength(0);
  });

  it('act はコマンドをバスへ押し出し、ack で解決する', async () => {
    const now = { t: 0 };
    const { mgr, pushed } = setup(now);
    mgr.onPageEvent({ kind: 'hello' });
    const p = mgr.act([{ type: 'motion', name: 'jab' }]);
    expect(pushed).toHaveLength(1);
    mgr.onPageEvent({ kind: 'ack', seq: pushed[0]!.seq, ok: true });
    const r = await p;
    expect(r.ok).toBe(true);
  });

  it('ack が来なければタイムアウトで失敗を返す', async () => {
    vi.useFakeTimers();
    try {
      const now = { t: 0 };
      const { mgr, pushed } = setup(now, 500);
      mgr.onPageEvent({ kind: 'hello' });
      const p = mgr.act([{ type: 'say', text: 'x' }]);
      expect(pushed).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(600);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('応答なし');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ack の失敗はエラー詳細を伝える', async () => {
    const now = { t: 0 };
    const { mgr, pushed } = setup(now);
    mgr.onPageEvent({ kind: 'hello' });
    const p = mgr.act([{ type: 'spawn', shape: 'box' }]);
    mgr.onPageEvent({ kind: 'ack', seq: pushed[0]!.seq, ok: false, errors: ['spawn: 座標が広場の外'] });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('広場の外');
  });

  it('チャットはハンドラへ渡り、say と共にログへ蓄積されて observe で見える', () => {
    const now = { t: 0 };
    const { mgr } = setup(now);
    const seen: string[] = [];
    mgr.setChatHandler((t) => seen.push(t));
    mgr.onPageEvent({ kind: 'chat', text: 'こんにちは' });
    expect(seen).toEqual(['こんにちは']);
    // 空文字は拒否しハンドラも呼ばない
    expect(mgr.onPageEvent({ kind: 'chat', text: '  ' }).ok).toBe(false);
    expect(seen).toHaveLength(1);
    const obs = mgr.observe();
    expect(obs.chat).toEqual([{ from: 'user', text: 'こんにちは' }]);
  });

  it('state/ack の state スナップショットが observe に反映される', () => {
    const now = { t: 0 };
    const { mgr } = setup(now);
    mgr.onPageEvent({ kind: 'state', state: { avatar: { x: 1, z: 2, motion: 'idle' } } });
    expect(mgr.observe().state?.avatar?.x).toBe(1);
    expect(mgr.observe().connected).toBe(true);
  });

  // ---- M115-4: 永続化と再入場復元 ----

  it('spawn/remove が正本へ反映され、ディスクへ保存→別インスタンスで読み戻せる', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'world-canon-'));
    const path = join(dir, 'world-state.json');

    const now = { t: 0 };
    const { mgr, pushed } = setup(now);
    mgr.loadPersisted(path);
    mgr.onPageEvent({ kind: 'hello' });
    const p1 = mgr.act([
      { type: 'spawn', id: 'tv', shape: 'box', x: 1, z: 2, color: '#111111' },
      { type: 'spawn', id: 'sign', shape: 'sign', x: 0, z: 0, label: 'ようこそ' },
      { type: 'say', text: '設置しました' },
    ]);
    mgr.onPageEvent({ kind: 'ack', seq: pushed[0]!.seq, ok: true });
    await p1;
    const p2 = mgr.act([{ type: 'remove', id: 'sign' }]);
    mgr.onPageEvent({ kind: 'ack', seq: pushed[1]!.seq, ok: true });
    await p2;

    // 別インスタンス(=アプリ再起動相当)で読み戻す
    const bus2 = new EventBus();
    const restored: WorldPushPayload[] = [];
    bus2.subscribe('world:event', (p) => restored.push(p));
    const mgr2 = new WorldManager(bus2, () => 0, 500);
    mgr2.loadPersisted(path);
    mgr2.onPageEvent({ kind: 'hello' });
    expect(restored).toHaveLength(1);
    expect(restored[0]!.quiet).toBe(true);
    expect(restored[0]!.cmds).toEqual([{ type: 'spawn', id: 'tv', shape: 'box', x: 1, z: 2, color: '#111111' }]);
  });

  it('正本が空なら hello で復元バッチを流さない', () => {
    const now = { t: 0 };
    const { mgr, pushed } = setup(now);
    mgr.onPageEvent({ kind: 'hello' });
    expect(pushed).toHaveLength(0);
  });

  // ---- M120: アプリ(社)の正本 ----

  it('app_add/app_move/app_remove が正本へ反映され、helloで復元される', async () => {
    const now = { t: 0 };
    const { mgr, pushed } = setup(now);
    mgr.onPageEvent({ kind: 'hello' });
    const p1 = mgr.act([{ type: 'app_add', app: { id: 'calc', name: '電卓', x: 3, z: 4 } }]);
    mgr.onPageEvent({ kind: 'ack', seq: pushed[0]!.seq, ok: true });
    await p1;
    expect(mgr.listApps()).toEqual([{ id: 'calc', name: '電卓', x: 3, z: 4 }]);
    // 人間のドラッグ(app_moved)も正本へ
    expect(mgr.onPageEvent({ kind: 'app_moved', appId: 'calc', x: -2, z: 5 }).ok).toBe(true);
    expect(mgr.listApps()[0]).toMatchObject({ x: -2, z: 5 });
    // 復元バッチにapp_addが含まれる
    const restore = mgr.restorePayload();
    expect(restore?.cmds).toContainEqual({ type: 'app_add', app: expect.objectContaining({ id: 'calc' }) });
    // remove
    const p2 = mgr.act([{ type: 'app_remove', appId: 'calc' }]);
    mgr.onPageEvent({ kind: 'ack', seq: pushed[1]!.seq, ok: true });
    await p2;
    expect(mgr.listApps()).toHaveLength(0);
  });
});
