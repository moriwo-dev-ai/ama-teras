import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import type { ToolPlugin } from '../tools/types';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps } from './service';

/** M26-7: 会話の workspace 移動(conversationMoveWorkspace)の service 配線を固定する */

let ws1: string;
let ws2: string;

beforeEach(async () => {
  ws1 = await mkdtemp(join(tmpdir(), 'amateras-wsmove-a-'));
  ws2 = await mkdtemp(join(tmpdir(), 'amateras-wsmove-b-'));
});
afterEach(async () => {
  await rm(ws1, { recursive: true, force: true }).catch(() => {});
  await rm(ws2, { recursive: true, force: true }).catch(() => {});
});

function textProvider(text: string): LLMProvider {
  return {
    id: 'anthropic',
    async *complete(_req: CompletionRequest): AsyncGenerator<ProviderEvent> {
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

function makeService(opts: { main: LLMProvider; tools?: ToolPlugin[] }): {
  svc: AgentService;
  bus: EventBus;
  events: AgentEvent[];
  config: AppConfig;
  setConfig: ReturnType<typeof vi.fn>;
} {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe('chat:event', (e) => events.push(e));
  const config: AppConfig = {
    autoApprove: { safe: true, write: true, exec: true },
    provider: 'anthropic',
    model: '',
    scopeMode: 'project',
    workspace: ws1,
  };
  const setConfig = vi.fn((next: AppConfig) => {
    Object.assign(config, next);
    return structuredClone(config);
  });
  const reg = opts.tools ?? [];
  const svc = new AgentService({
    bus,
    registry: {
      list: () => reg,
      get: (n) => reg.find((p) => p.name === n),
      reload: async () => {},
      errors: [],
    },
    config: { get: () => structuredClone(config), set: setConfig },
    secrets: { get: () => 'key' },
    audit: { append: () => {} },
    defaultWorkspace: () => ws1,
    denyPaths: { userDataDir: join(ws1, '..', 'x-userdata'), repoGitDir: join(ws1, '..', 'x-git') },
    createEvolution: () => ({ list: () => [], enqueue: vi.fn(async () => 1) }),
    providerFactory: () => opts.main,
  } as AgentServiceDeps);
  return { svc, bus, events, config, setConfig };
}

function waitForTerminal(bus: EventBus): Promise<void> {
  return new Promise((resolve) => {
    const unsub = bus.subscribe('chat:event', (e) => {
      if (e.kind === 'status' && ['done', 'error', 'cancelled', 'max_turns_reached'].includes(e.status)) {
        unsub();
        resolve();
      }
    });
  });
}

describe('M26-7: conversationMoveWorkspace', () => {
  it('アイドル時の移動: ok + 設定追従 + infoイベント + 次のランのツールが新workspaceを参照する', async () => {
    const cwds: string[] = [];
    const echoTool: ToolPlugin = {
      name: 'echo_cwd',
      description: 'cwd echo',
      inputSchema: { type: 'object', properties: {} },
      risk: 'safe',
      execute: async (_input, ctx) => {
        cwds.push(ctx.cwd);
        return { content: ctx.cwd };
      },
    };
    const main: LLMProvider = {
      id: 'anthropic',
      async *complete(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
        // 1ターン目: ツール実行 → 2ターン目: 完了
        const hasToolResult = JSON.stringify(req.messages).includes('tool_result');
        yield {
          type: 'message_done',
          message: hasToolResult
            ? { role: 'assistant', content: [{ type: 'text', text: '完了' }] }
            : { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo_cwd', input: {} }] },
          stopReason: hasToolResult ? 'end_turn' : 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        };
      },
    };
    const { svc, bus, events, setConfig } = makeService({ main, tools: [echoTool] });

    const r = svc.conversationMoveWorkspace(ws2);
    expect(r.ok).toBe(true);
    expect(setConfig).toHaveBeenCalledWith(expect.objectContaining({ workspace: ws2 }));
    expect(
      events.some((e) => e.kind === 'info' && e.message.includes('作業ディレクトリを移動した')),
    ).toBe(true);

    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    expect(cwds).toEqual([ws2]); // 以降のツール実行は移動先を参照
  });

  it('実行中の会話は移動できない(ok:false)', async () => {
    let midRunResult: { ok: boolean; message: string } | null = null;
    let svcRef: AgentService | null = null;
    const probeTool: ToolPlugin = {
      name: 'probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: {} },
      risk: 'safe',
      execute: async () => {
        // ラン実行中(conv.runあり)に移動を試みる
        midRunResult = svcRef!.conversationMoveWorkspace(ws2);
        return { content: 'ok' };
      },
    };
    const main: LLMProvider = {
      id: 'anthropic',
      async *complete(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
        const hasToolResult = JSON.stringify(req.messages).includes('tool_result');
        yield {
          type: 'message_done',
          message: hasToolResult
            ? { role: 'assistant', content: [{ type: 'text', text: '完了' }] }
            : { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'probe', input: {} }] },
          stopReason: hasToolResult ? 'end_turn' : 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
        };
      },
    };
    const { svc, bus } = makeService({ main, tools: [probeTool] });
    svcRef = svc;
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    expect(midRunResult).toMatchObject({ ok: false });
    expect((midRunResult as unknown as { message: string }).message).toContain('実行中');
  });

  it('存在しないパス・相対パス・同一workspaceは拒否される', () => {
    const { svc } = makeService({ main: textProvider('x') });
    expect(svc.conversationMoveWorkspace(join(ws2, 'nonexistent-sub'))).toMatchObject({ ok: false });
    expect(svc.conversationMoveWorkspace('relative/path')).toMatchObject({ ok: false });
    expect(svc.conversationMoveWorkspace(ws1)).toMatchObject({ ok: false }); // 現在と同じ
  });
});
