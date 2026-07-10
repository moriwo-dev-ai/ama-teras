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
  fetchFn?: typeof fetch;
  fallbackProviderFactory?: AgentServiceDeps['fallbackProviderFactory'];
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
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.fallbackProviderFactory !== undefined
      ? { fallbackProviderFactory: opts.fallbackProviderFactory }
      : {}),
  });
  return { svc, bus, events, secretCalls, enqueue };
}

/** M28-3: private の evolutionContext を型を絞って呼ぶ(テスト専用の覗き穴) */
function evolutionCtxOf(svc: AgentService): {
  searchRegistryAndImport: (
    d: string,
    e: string,
    sig: AbortSignal,
  ) => Promise<{ outcome: string; jobId?: number; name?: string }>;
} {
  return (
    svc as unknown as { evolutionContext: () => ReturnType<typeof evolutionCtxOf> }
  ).evolutionContext();
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
    const base = mkdtempSync(join(tmpdir(), 'amateras-svc-imp-'));
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

describe('M28-3: searchRegistryAndImport(service統合)', () => {
  const INDEX = {
    registryVersion: 1,
    plugins: [
      {
        name: 'word_count',
        description: '文字数を数えるツール',
        version: '1.0.0',
        author: 'someone',
        verified: true,
        path: 'plugins/word_count',
        files: ['word_count.ts', 'manifest.json'],
      },
    ],
  };
  const MANIFEST = JSON.stringify({
    name: 'word_count',
    version: '1.0.0',
    pluginApiVersion: '^1',
    description: '文字数を数えるツール',
    author: 'someone',
    license: 'MIT',
    permissions: { network: false, childProcess: false, fsScope: 'none' },
    dependencies: [],
  });

  function registryFetch(routes: Record<string, string | object>): typeof fetch {
    return (async (url: unknown) => {
      const body = routes[String(url)];
      if (body === undefined) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      };
    }) as unknown as typeof fetch;
  }

  /** 承認カードへ自動応答するリスナーを張る */
  function autoRespond(s: ReturnType<typeof makeService>, decision: 'allow' | 'deny'): string[] {
    const requested: string[] = [];
    s.bus.subscribe('approval:request', (req) => {
      requested.push(req.toolName);
      s.svc.approvalRespond(req.id, decision);
    });
    return requested;
  }

  it('候補あり+承諾 → ダウンロード → importFrom付きで enqueue される', async () => {
    const s = makeService({
      config: { registryUrl: 'https://reg.example' },
      fetchFn: registryFetch({
        'https://reg.example/index.json': INDEX,
        'https://reg.example/plugins/word_count/word_count.ts': `export default { name: 'word_count' };`,
        'https://reg.example/plugins/word_count/manifest.json': MANIFEST,
      }),
    });
    const requested = autoRespond(s, 'allow');
    const r = await evolutionCtxOf(s.svc).searchRegistryAndImport(
      '文字数を数えたい',
      'テキスト→数',
      new AbortController().signal,
    );
    expect(requested).toEqual(['registry-search']);
    expect(r.outcome).toBe('imported');
    expect(r.jobId).toBe(1);
    expect(s.enqueue).toHaveBeenCalledTimes(1);
    const req = s.enqueue.mock.calls[0]![0] as { importFrom?: string; scope?: string; targetTool?: string };
    expect(req.scope).toBe('tool');
    expect(req.importFrom).toContain('word_count');
  });

  it('拒否(=新規生成を選択)は declined を返し enqueue しない', async () => {
    const s = makeService({
      config: { registryUrl: 'https://reg.example' },
      fetchFn: registryFetch({ 'https://reg.example/index.json': INDEX }),
    });
    autoRespond(s, 'deny');
    const r = await evolutionCtxOf(s.svc).searchRegistryAndImport('文字数を数えたい', 'x', new AbortController().signal);
    expect(r.outcome).toBe('declined');
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it('registryUrl 未設定・不達・マッチなしは none(カードも出さない)', async () => {
    const cases: ReturnType<typeof makeService>[] = [
      makeService({}), // 未設定
      makeService({
        config: { registryUrl: 'https://reg.example' },
        fetchFn: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch, // 不達
      }),
      makeService({
        config: { registryUrl: 'https://reg.example' },
        fetchFn: registryFetch({ 'https://reg.example/index.json': INDEX }), // マッチなし
      }),
    ];
    const queries = ['文字数を数えたい', '文字数を数えたい', 'zzz qqq'] as const;
    for (const [i, s] of cases.entries()) {
      const requested = autoRespond(s, 'allow');
      const r = await evolutionCtxOf(s.svc).searchRegistryAndImport(queries[i]!, 'vvv', new AbortController().signal);
      expect(r.outcome, `case ${i}`).toBe('none');
      expect(requested, `case ${i}`).toHaveLength(0);
      expect(s.enqueue).not.toHaveBeenCalled();
    }
  });
});

describe('M29-1: connectionTest の診断表示', () => {
  it('失敗時に 実URL・model・HTTPステータス・レスポンスbody を含める', async () => {
    const boom: LLMProvider = {
      id: 'openai',
      // eslint-disable-next-line require-yield
      async *complete(): AsyncGenerator<ProviderEvent> {
        throw Object.assign(new Error('404 status code (no body)'), {
          status: 404,
          error: { message: 'model not found' },
        });
      },
    };
    const { svc } = makeService({
      config: { provider: 'openai', providerPreset: 'gemini', freeMode: true },
      providerFactory: () => boom,
    });
    const r = await svc.connectionTest();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(r.message).toContain('HTTP 404');
    expect(r.message).toContain('model not found');
    expect(r.message).toContain('gemini-3.5-flash'); // プリセット既定モデル
  });
});

describe('M29-4: registryUrl 空文字=検索無効', () => {
  it("registryUrl='' のときは検索せず none(カードなし)", async () => {
    const s = makeService({ config: { registryUrl: '' } });
    const requested: string[] = [];
    s.bus.subscribe('approval:request', (req) => requested.push(req.toolName));
    const r = await evolutionCtxOf(s.svc).searchRegistryAndImport('文字数を数えたい', 'x', new AbortController().signal);
    expect(r.outcome).toBe('none');
    expect(requested).toHaveLength(0);
  });
});

describe('M30-2: モデル未開放(404)の安定版フォールバック', () => {
  const errModel404 = (): Error =>
    Object.assign(new Error("404 The model 'gpt-5.6-sol' does not exist or you do not have access to it"), {
      status: 404,
    });

  function throwingProvider(): LLMProvider {
    return {
      id: 'openai',
      // eslint-disable-next-line require-yield
      async *complete(): AsyncGenerator<ProviderEvent> {
        throw errModel404();
      },
    };
  }

  it('stableFallbackLLM: gpt-5.6系→gpt-5.5、対象外は null', () => {
    const { svc } = makeService({});
    const stable = (
      svc as unknown as {
        stableFallbackLLM: (c: { provider: string; model: string }) => { provider: string; model: string } | null;
      }
    ).stableFallbackLLM.bind(svc);
    expect(stable({ provider: 'openai', model: 'gpt-5.6-sol' })).toEqual({ provider: 'openai', model: 'gpt-5.5' });
    expect(stable({ provider: 'openai', model: 'gpt-5.6-terra' })).toEqual({ provider: 'openai', model: 'gpt-5.5' });
    expect(stable({ provider: 'openai', model: 'gpt-5.5' })).toBeNull();
    expect(stable({ provider: 'anthropic', model: 'claude-fable-5' })).toBeNull();
  });

  it('main 404 → gpt-5.5 で同一ターン続行(警告カード付き)。フォールバック設定は不要', async () => {
    const stableProvider = textProvider('openai', '安定版で応答');
    const factory = vi.fn(() => stableProvider);
    const { svc, bus, events } = makeService({
      config: { provider: 'openai' }, // model空=既定 gpt-5.6-sol
      providerFactory: () => throwingProvider(),
      fallbackProviderFactory: factory,
    });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    expect(factory).toHaveBeenCalledWith('openai', 'gpt-5.5');
    expect(stableProvider.requests).toHaveLength(1);
    const infos = events.filter((e) => e.kind === 'info').map((e) => (e as { message: string }).message);
    expect(infos.some((m) => m.includes('未開放') && m.includes('gpt-5.5'))).toBe(true);
    const last = events.at(-1);
    expect(last?.kind === 'status' && last.status).toBe('done');
  });

  it('1会話1回まで: 安定版でも404なら平易説明+設定導線つきエラーで停止', async () => {
    const { svc, bus, events } = makeService({
      config: { provider: 'openai' },
      providerFactory: () => throwingProvider(),
      fallbackProviderFactory: () => throwingProvider(), // 安定版側も404
    });
    const terminal = waitForTerminal(bus);
    svc.chatSend('やって', 'normal');
    await terminal;
    const err = events.find((e) => e.kind === 'error');
    expect(err?.kind === 'error' && err.message).toContain('まだ開放されていない可能性');
    expect(err?.kind === 'error' && err.settingsHint).toBe('basic');
  });
});
