import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AppConfig, ModelPolicy, ProviderId, SecretSlot } from '../../shared/types';
import type { CompletionRequest, LLMProvider, ProviderEvent } from '../providers/types';
import requestCapability from '../tools/plugins/request_capability';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps } from './service';

/**
 * M27-1: 無料APIモード(freeMode / providerPreset)の service 配線を固定する。
 * - freeMode 中は modelPolicy が無効(帯生成が呼ばれない)
 * - providerPreset は専用キースロット(gemini等)で OpenAI互換プロバイダを生成する
 * - request_capability は freeMode 中はジョブを起動せず案内文を返す(オプトイン解除可)
 * - connectionTest は現在の設定で1リクエスト送り成否を返す
 */

const POLICY: ModelPolicy = {
  enabled: true,
  planner: { provider: 'anthropic', model: 'claude-fable-5' },
  worker: { provider: 'anthropic', model: 'claude-haiku-4-5' },
};

function textProvider(id: ProviderId, text: string): LLMProvider & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    id,
    requests,
    async *complete(req: CompletionRequest): AsyncGenerator<ProviderEvent> {
      requests.push(req);
      yield {
        type: 'message_done',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
      };
    },
  };
}

function makeService(opts: {
  config?: Partial<AppConfig>;
  secrets?: (p: SecretSlot) => string | null;
  bandProviderFactory?: AgentServiceDeps['bandProviderFactory'];
  providerFactory?: () => LLMProvider | string;
  registry?: AgentServiceDeps['registry'];
  enqueue?: () => Promise<number>;
}): {
  svc: AgentService;
  bus: EventBus;
  events: AgentEvent[];
  secretCalls: SecretSlot[];
  enqueue: ReturnType<typeof vi.fn>;
} {
  const bus = new EventBus();
  const events: AgentEvent[] = [];
  bus.subscribe('chat:event', (e) => events.push(e));
  const secretCalls: SecretSlot[] = [];
  const config: AppConfig = {
    autoApprove: { safe: true, write: true, exec: false },
    provider: 'anthropic',
    model: '',
    scopeMode: 'project',
    ...opts.config,
  };
  const enqueue = vi.fn(opts.enqueue ?? (async () => 1));
  const svc = new AgentService({
    bus,
    registry: opts.registry ?? { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(config) },
    secrets: {
      get: (p: SecretSlot) => {
        secretCalls.push(p);
        return opts.secrets !== undefined ? opts.secrets(p) : 'test-key';
      },
    },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: () => ({ list: () => [], enqueue }),
    ...(opts.bandProviderFactory !== undefined ? { bandProviderFactory: opts.bandProviderFactory } : {}),
    ...(opts.providerFactory !== undefined ? { providerFactory: opts.providerFactory } : {}),
  });
  return { svc, bus, events, secretCalls, enqueue };
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

describe('M27-1: freeMode は modelPolicy を無効化する', () => {
  it('policy有効でも freeMode 中は帯生成が呼ばれずメインは従来経路で動く', async () => {
    const main = textProvider('anthropic', '応答');
    const bandFactory = vi.fn();
    const { svc, bus } = makeService({
      config: { modelPolicy: POLICY, freeMode: true },
      providerFactory: () => main,
      bandProviderFactory: bandFactory as never,
    });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    expect(main.requests).toHaveLength(1);
    expect(bandFactory).not.toHaveBeenCalled();
  });
});

describe('M27-1: providerPreset のプロバイダ生成', () => {
  it('preset(gemini)使用時は専用スロットのキーで生成される', () => {
    const { svc, secretCalls } = makeService({
      config: { provider: 'openai', providerPreset: 'gemini', freeMode: true },
    });
    const provider = svc.createProvider();
    expect(typeof provider).not.toBe('string');
    expect(secretCalls).toContain('gemini');
    expect(secretCalls).not.toContain('openai');
  });

  it('preset のキー未登録は「無料で始める」への案内メッセージを返す', () => {
    const { svc } = makeService({
      config: { provider: 'openai', providerPreset: 'groq', freeMode: true },
      secrets: () => null,
    });
    const provider = svc.createProvider();
    expect(typeof provider).toBe('string');
    expect(provider).toContain('無料で始める');
  });

  it('preset未設定の openai は従来どおり openai スロットを使う(後方互換)', () => {
    const { svc, secretCalls } = makeService({ config: { provider: 'openai' } });
    const provider = svc.createProvider();
    expect(typeof provider).not.toBe('string');
    expect(secretCalls).toContain('openai');
  });
});

describe('M27-1: freeMode は request_capability の新規生成を止める', () => {
  const reg = [requestCapability];
  const registry = {
    list: () => reg,
    get: (n: string) => reg.find((p) => p.name === n),
    reload: async () => {},
    errors: [],
  };
  const input = JSON.stringify({ description: '新ツール', expected_io: 'in -> out' });

  it('freeMode 中はジョブを起動せず案内文を返す', async () => {
    const { svc, enqueue } = makeService({ config: { freeMode: true }, registry });
    const r = await svc.toolsExecute('request_capability', input);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('無料モードでは新規生成は行えません');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('freeModeAllowEvolution=true のオプトインで従来どおり起動できる', async () => {
    const { svc, enqueue } = makeService({
      config: { freeMode: true, freeModeAllowEvolution: true },
      registry,
    });
    const r = await svc.toolsExecute('request_capability', input);
    expect(r.isError).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('freeMode でなければ従来どおり起動できる(回帰)', async () => {
    const { svc, enqueue } = makeService({ registry });
    const r = await svc.toolsExecute('request_capability', input);
    expect(r.isError).toBe(false);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('M27-1: connectionTest', () => {
  it('成功すると ok:true と provider/model を返す', async () => {
    const main = textProvider('anthropic', 'OK');
    const { svc } = makeService({ providerFactory: () => main });
    const r = await svc.connectionTest();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('接続OK');
    expect(main.requests).toHaveLength(1);
    expect(main.requests[0]!.maxTokens).toBeLessThanOrEqual(64); // 最小リクエストであること
  });

  it('プロバイダ例外は ok:false とエラー概要を返す', async () => {
    const boom: LLMProvider = {
      id: 'openai',
      // eslint-disable-next-line require-yield
      async *complete(): AsyncGenerator<ProviderEvent> {
        throw Object.assign(new Error('401 invalid api key'), { status: 401 });
      },
    };
    const { svc } = makeService({ providerFactory: () => boom });
    const r = await svc.connectionTest();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('接続失敗');
  });

  it('キー未設定はそのメッセージを返す', async () => {
    const { svc } = makeService({ config: { provider: 'openai' }, secrets: () => null });
    const r = await svc.connectionTest();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('未設定');
  });
});

describe('M27-4: pluginImportStart の enqueue 配線', () => {
  function makeImportDir(name: string): { dir: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), 'mycodex-svc-imp-'));
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        pluginApiVersion: '^1',
        description: 'テスト',
        author: '',
        license: 'MIT',
        permissions: { network: false, childProcess: false, fsScope: 'none' },
        dependencies: [],
      }),
    );
    writeFileSync(join(dir, `${name}.ts`), `export default { name: '${name}' };`);
    return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) };
  }

  it('検査合格なら importFrom 付きで enqueue され、既存同名ツールなら targetTool も付く', async () => {
    const { dir, cleanup } = makeImportDir('imported_tool');
    try {
      const { svc, enqueue } = makeService({});
      const r = await svc.pluginImportStart(dir);
      expect(r.ok).toBe(true);
      expect(r.jobId).toBe(1);
      expect(enqueue).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'tool', importFrom: dir }),
      );
      expect((enqueue.mock.calls[0]![0] as { targetTool?: string }).targetTool).toBeUndefined();

      // 既存同名ツールがあると「既存修正」として扱う
      const existing = {
        name: 'imported_tool',
        description: 'x',
        inputSchema: { type: 'object' as const, properties: {} },
        risk: 'safe' as const,
        execute: async () => ({ content: 'ok' }),
      };
      const reg = {
        list: () => [existing],
        get: (n: string) => (n === 'imported_tool' ? existing : undefined),
        reload: async () => {},
        errors: [],
      };
      const { svc: svc2, enqueue: enqueue2 } = makeService({ registry: reg });
      const r2 = await svc2.pluginImportStart(dir);
      expect(r2.ok).toBe(true);
      expect(enqueue2).toHaveBeenCalledWith(expect.objectContaining({ targetTool: 'imported_tool' }));
    } finally {
      cleanup();
    }
  });

  it('検査不合格(manifest欠落)は enqueue せずエラーメッセージを返す', async () => {
    const { svc, enqueue } = makeService({});
    const r = await svc.pluginImportStart(join(tmpdir(), 'no-such-dir-xyz'));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('検査に失敗');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
