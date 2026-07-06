import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, SubAgentUpdate } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps, type CheckpointsLike } from './service';

/** M12-3: AgentService の並列サブエージェント配線(チェックポイント・イベント・集約)を固定 */

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: true, exec: true },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

function textProvider(): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(req): AsyncGenerator<ProviderEvent> {
      // 子タスクのテキストをそのまま要約として返す(どの子か識別できるように)
      const first = req.messages[0]!.content[0]!;
      const echo = first.type === 'text' ? first.text : '?';
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text: `済: ${echo}` }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

function makeService(overrides?: Partial<AgentServiceDeps>): {
  svc: AgentService;
  bus: EventBus;
  snapshots: string[];
} {
  const bus = new EventBus();
  const snapshots: string[] = [];
  const checkpoints: CheckpointsLike = {
    workspace: process.cwd(),
    snapshot: async (_sid, label) => {
      snapshots.push(label);
      return 'a'.repeat(40);
    },
    list: async () => [],
    restore: async () => ({ ok: true, message: '' }),
  };
  const svc = new AgentService({
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(BASE_CONFIG) },
    secrets: { get: () => null },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    createCheckpoints: () => checkpoints,
    ...overrides,
  });
  return { svc, bus, snapshots };
}

describe('AgentService.runParallelSubAgents(M12-3)', () => {
  it('fan-out 直前にチェックポイントを1回作り、全子の要約を並び順どおり返す', async () => {
    const { svc, bus, snapshots } = makeService();
    const updates: SubAgentUpdate[] = [];
    bus.subscribe('agent:sub_update', (u) => updates.push(u));

    const results = await svc.runParallelSubAgents(
      textProvider(),
      'sess-1',
      ['タスクA', 'タスクB'],
      'work',
      new AbortController().signal,
    );

    expect(results).toEqual(['済: タスクA', '済: タスクB']);
    expect(snapshots).toEqual(['サブエージェント並列実行前(work×2)']);
    // 各子について running → done がバスへ流れる(id は連番)
    const ids = [...new Set(updates.map((u) => u.id))];
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      const seq = updates.filter((u) => u.id === id).map((u) => u.status);
      expect(seq[0]).toBe('running');
      expect(seq[seq.length - 1]).toBe('done');
    }
  });

  it('read モードの並列も動き、4件以上は既定3件に制限される', async () => {
    const { svc, bus } = makeService();
    const updates: SubAgentUpdate[] = [];
    bus.subscribe('agent:sub_update', (u) => updates.push(u));

    const results = await svc.runParallelSubAgents(
      textProvider(),
      'sess-2',
      ['1', '2', '3', '4'],
      'read',
      new AbortController().signal,
    );
    expect(results).toHaveLength(3);
    expect(updates.every((u) => u.mode === 'read')).toBe(true);
    // M23: 子が使うモデルのラベル(policy無効=メインと同一モデル)が付く
    expect(updates.every((u) => u.model === 'claude-fable-5')).toBe(true);
  });

  it('M21-2: subAgentMaxParallel 設定で同時数が変わる(5設定→5本・範囲外はクランプ)', async () => {
    const cfg5: AppConfig = { ...BASE_CONFIG, subAgentMaxParallel: 5 };
    const { svc } = makeService({ config: { get: () => structuredClone(cfg5) } });
    const results = await svc.runParallelSubAgents(
      textProvider(),
      'sess-4',
      ['1', '2', '3', '4', '5', '6'],
      'read',
      new AbortController().signal,
    );
    expect(results).toHaveLength(5);

    // 範囲外(99)は8へクランプ
    const cfg99: AppConfig = { ...BASE_CONFIG, subAgentMaxParallel: 99 };
    const { svc: svc99 } = makeService({ config: { get: () => structuredClone(cfg99) } });
    const nine = await svc99.runParallelSubAgents(
      textProvider(),
      'sess-5',
      Array.from({ length: 9 }, (_, i) => String(i)),
      'read',
      new AbortController().signal,
    );
    expect(nine).toHaveLength(8);
  });

  it('チェックポイント未設定(非gitワークスペース等)でも失敗しない', async () => {
    const { svc } = makeService({ createCheckpoints: undefined });
    const results = await svc.runParallelSubAgents(
      textProvider(),
      'sess-3',
      ['x'],
      'work',
      new AbortController().signal,
    );
    expect(results).toEqual(['済: x']);
  });
});
