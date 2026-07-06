import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, AutonomousStatePayload } from '../../shared/types';
import type { ScopeAuditEvent } from '../tools/executor';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps } from './service';
import { SESSION_SCHEMA_VERSION, type SessionData } from './sessions';

/**
 * M17-2: 自律モードの service テスト。
 * - 切替が監査とバス通知に反映される
 * - セッション新規/切替でOFFに戻る(状態はセッション単位。再起動OFFはメモリ保持ゆえ自明)
 * - getStatus に露出する
 */

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

function makeService(overrides?: Partial<AgentServiceDeps>): {
  svc: AgentService;
  bus: EventBus;
  audits: ScopeAuditEvent[];
} {
  const bus = new EventBus();
  const audits: ScopeAuditEvent[] = [];
  const svc = new AgentService({
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(BASE_CONFIG) },
    secrets: { get: () => null },
    audit: { append: (e) => audits.push(e) },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    ...overrides,
  });
  return { svc, bus, audits };
}

describe('自律モード(M17-2)', () => {
  it('既定はOFFで getStatus に露出する', () => {
    const { svc } = makeService();
    expect(svc.getAutonomous()).toBe(false);
    expect(svc.getStatus().autonomous).toBe(false);
  });

  it('ON/OFF切替で監査記録とバス通知が出る', () => {
    const { svc, bus, audits } = makeService();
    const events: AutonomousStatePayload[] = [];
    bus.subscribe('autonomous:changed', (p) => events.push(p));

    expect(svc.setAutonomous(true)).toEqual({ on: true });
    expect(svc.getStatus().autonomous).toBe(true);
    expect(svc.setAutonomous(false)).toEqual({ on: false });

    expect(events).toEqual([{ on: true }, { on: false }]);
    const toggles = audits.filter((a) => a.tool === 'autonomous-mode');
    expect(toggles.map((a) => a.detail)).toEqual(['on', 'off']);
    for (const t of toggles) expect(t.autonomous).toBe(true);
  });

  it('同じ状態への切替は何も起こさない(冪等)', () => {
    const { svc, bus, audits } = makeService();
    const events: AutonomousStatePayload[] = [];
    bus.subscribe('autonomous:changed', (p) => events.push(p));
    svc.setAutonomous(false);
    expect(events).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('新規セッションでOFFに戻る', () => {
    const { svc } = makeService();
    svc.setAutonomous(true);
    expect(svc.sessionNew().ok).toBe(true);
    expect(svc.getAutonomous()).toBe(false);
  });

  it('セッション切替(ロード)でOFFに戻る', async () => {
    const data: SessionData = {
      version: SESSION_SCHEMA_VERSION,
      id: 'a1b2c3d4-0000-0000-0000-000000000000',
      title: 't',
      workspace: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      history: [],
    };
    const { svc } = makeService({
      sessions: {
        save: async () => {},
        load: async () => data,
        list: async () => [],
        delete: async () => {},
      },
    });
    svc.setAutonomous(true);
    const result = await svc.sessionLoad(data.id);
    expect(result.ok).toBe(true);
    expect(svc.getAutonomous()).toBe(false);
  });
});
