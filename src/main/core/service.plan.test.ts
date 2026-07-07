import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import { EventBus } from './events';
import { AgentService } from './service';

/** M12-2: AMATERAS_PLAN.md が system prompt に注入されることを固定する */

const BASE_CONFIG: AppConfig = {
  autoApprove: { safe: true, write: false, exec: false },
  provider: 'anthropic',
  model: '',
  scopeMode: 'project',
};

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'mycodex-planws-'));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true }).catch(() => {});
});

function capturingProvider(): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id: 'anthropic',
    requests,
    async *complete(req): AsyncGenerator<ProviderEvent> {
      requests.push(req);
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

function makeService(provider: LLMProvider): { svc: AgentService; bus: EventBus } {
  const bus = new EventBus();
  const svc = new AgentService({
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(BASE_CONFIG) },
    secrets: { get: () => null },
    audit: { append: () => {} },
    defaultWorkspace: () => ws,
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    providerFactory: () => provider,
  });
  return { svc, bus };
}

function waitForDone(bus: EventBus): Promise<void> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe('chat:event', (e) => {
      if (e.kind === 'status' && ['done', 'error'].includes(e.status)) {
        unsub();
        resolve();
      }
    });
  });
}

describe('AgentService × 計画注入(M12-2)', () => {
  it('AMATERAS_PLAN.md があれば system prompt に「## 現在の計画」として入る', async () => {
    writeFileSync(join(ws, 'AMATERAS_PLAN.md'), '- [ ] REST APIの雛形\n- [x] 設計', 'utf8');
    const provider = capturingProvider();
    const { svc, bus } = makeService(provider);
    const done = waitForDone(bus);
    svc.chatSend('続けて', 'normal');
    await done;

    const system = provider.requests[0]!.system;
    expect(system).toContain('## 現在の計画');
    expect(system).toContain('- [ ] REST APIの雛形');
    // 運用指示(planツールを使う規範)も system に含まれる
    expect(system).toContain('plan ツール');
    // M24-2: 能力ギャップ評価の規範(新ツールの積極提案)も system に含まれる
    expect(system).toContain('能力ギャップ');
    expect(system).toContain('request_capability');
  });

  it('計画が無ければ従来どおり(計画セクションなし)', async () => {
    const provider = capturingProvider();
    const { svc, bus } = makeService(provider);
    const done = waitForDone(bus);
    svc.chatSend('こんにちは', 'normal');
    await done;
    expect(provider.requests[0]!.system).not.toContain('## 現在の計画');
  });
});
