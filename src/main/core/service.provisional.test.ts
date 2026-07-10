import { describe, expect, it, vi } from 'vitest';
import type {
  AgentEvent,
  AppConfig,
  AutonomousRegistryScope,
  EvolutionJobSummary,
  ProvisionalInstall,
} from '../../shared/types';
import { EventBus } from './events';
import { AgentService, type AgentServiceDeps, type EvolutionHooks } from './service';

/**
 * M29-5: 仮導入(包括承認)+事後棚卸しの service 配線を固定する。
 * 契約(M20不変条件3のユーザー指示による更新・NIGHT_TASKS4 T5):
 * - 昇格の無人承認は「実行開始時の包括承認で事前登録されたジョブ」×「scope=tool」×
 *   「危険警告ゼロ」の全条件を満たす仮導入のみ。renderer/core・危険権限は常に人間承認
 * - 検証済み+危険権限なしの候補のみ無人仮導入。範囲外は個別カード(タイムアウト付き)
 * - 棚卸し: 残す=確定 / 削除=完全アンインストール。未応答は永続化され再提示
 */

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

function manifestJson(perms: { network?: boolean; childProcess?: boolean } = {}): string {
  return JSON.stringify({
    name: 'word_count',
    version: '1.0.0',
    pluginApiVersion: '^1',
    description: '文字数を数えるツール',
    author: 'someone',
    license: 'MIT',
    permissions: { network: perms.network ?? false, childProcess: perms.childProcess ?? false, fsScope: 'none' },
    dependencies: [],
  });
}

/** networkを実際に使い、宣言も一致しているコード(検査は通るが危険権限持ち) */
const CODE_SAFE = `export default { name: 'word_count' };`;
const CODE_NETWORK = `export default { name: 'word_count', async execute(){ await fetch('https://x'); } };`;

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

function routes(opts: { verified?: boolean; code?: string; manifest?: string } = {}): Record<string, string | object> {
  const idx = structuredClone(INDEX);
  if (opts.verified === false) idx.plugins[0]!.verified = false;
  return {
    'https://reg.example/index.json': idx,
    'https://reg.example/plugins/word_count/word_count.ts': opts.code ?? CODE_SAFE,
    'https://reg.example/plugins/word_count/manifest.json': opts.manifest ?? manifestJson(),
  };
}

function makeService(opts: {
  fetchFn?: typeof fetch;
  seed?: ProvisionalInstall[];
  timeoutMs?: number;
  uninstall?: (jobId: number) => Promise<{ ok: boolean; message: string }>;
}): {
  svc: AgentService;
  bus: EventBus;
  hooks: () => EvolutionHooks;
  enqueue: ReturnType<typeof vi.fn>;
  uninstall: ReturnType<typeof vi.fn>;
  saved: () => ProvisionalInstall[] | null;
  requested: { toolName: string; warnings: string[] }[];
  respond: (decision: 'allow' | 'deny') => void;
} {
  const bus = new EventBus();
  const config: AppConfig = {
    autoApprove: { safe: true, write: true, exec: false },
    provider: 'anthropic',
    model: '',
    scopeMode: 'project',
    registryUrl: 'https://reg.example',
  };
  const enqueue = vi.fn(async () => 1);
  const uninstall = vi.fn(opts.uninstall ?? (async () => ({ ok: true, message: 'reverted' })));
  let captured: EvolutionHooks | null = null;
  let savedItems: ProvisionalInstall[] | null = null;
  const requested: { toolName: string; warnings: string[] }[] = [];
  let respondMode: 'allow' | 'deny' | 'never' = 'never';
  bus.subscribe('approval:request', (req) => {
    requested.push({ toolName: req.toolName, warnings: req.warnings });
    if (respondMode !== 'never') svc.approvalRespond(req.id, respondMode);
  });
  const svc = new AgentService({
    bus,
    registry: { list: () => [], get: () => undefined, reload: async () => {}, errors: [] },
    config: { get: () => structuredClone(config) },
    secrets: { get: () => 'test-key' },
    audit: { append: () => {} },
    defaultWorkspace: () => process.cwd(),
    denyPaths: { userDataDir: '/tmp/x-userdata', repoGitDir: '/tmp/x-git' },
    createEvolution: (hooks) => {
      captured = hooks;
      return { list: () => [], enqueue, uninstallPromotion: uninstall };
    },
    ...(opts.fetchFn !== undefined ? { fetchFn: opts.fetchFn } : {}),
    provisionalStore: {
      load: () => opts.seed ?? [],
      save: (items) => {
        savedItems = items;
      },
    },
    ...(opts.timeoutMs !== undefined ? { individualApprovalTimeoutMs: opts.timeoutMs } : {}),
  } as AgentServiceDeps);
  return {
    svc,
    bus,
    hooks: () => {
      if (captured === null) throw new Error('hooks未捕捉');
      return captured;
    },
    enqueue,
    uninstall,
    saved: () => savedItems,
    requested,
    respond: (d) => {
      respondMode = d;
    },
  };
}

/** private の searchRegistryAndImport を現在会話(自律設定済み)の origin 付きで呼ぶ */
async function search(
  svc: AgentService,
  scope: AutonomousRegistryScope | null,
): Promise<{ outcome: string; jobId?: number; name?: string }> {
  if (scope !== null) svc.setAutonomous(true, scope);
  const inner = svc as unknown as {
    current: unknown;
    evolutionContext: (o?: unknown) => {
      searchRegistryAndImport: (d: string, e: string, s: AbortSignal) => Promise<{ outcome: string; jobId?: number }>;
    };
  };
  return inner.evolutionContext(inner.current).searchRegistryAndImport('文字数を数えたい', 'x', new AbortController().signal);
}

const toolJob = (over: Partial<EvolutionJobSummary> = {}): EvolutionJobSummary => ({
  id: 1,
  description: 'x',
  status: 'awaiting_promotion',
  log: [],
  gates: [],
  toolName: 'word_count',
  scope: 'tool',
  ...over,
});

describe('M29-5: 自律モードの包括承認範囲', () => {
  it('none: 検索せずスキップ(現行どおり生成へ直行)', async () => {
    const fetchFn = vi.fn(registryFetch(routes()));
    const s = makeService({ fetchFn });
    const r = await search(s.svc, 'none');
    expect(r.outcome).toBe('none');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(s.requested).toHaveLength(0);
  });

  it('verified: 検証済み+危険権限なしは承認カードなしで無人仮導入され、昇格が自動承認される', async () => {
    const s = makeService({ fetchFn: registryFetch(routes()) });
    const r = await search(s.svc, 'verified');
    expect(r.outcome).toBe('imported');
    expect(s.requested).toHaveLength(0); // カードなし
    expect(s.enqueue).toHaveBeenCalledTimes(1);
    // 昇格フック: 事前登録済み+tool+警告ゼロ → 即 true(人間の respond 不要)
    const approved = await s.hooks().requestPromotionApproval(toolJob(), 'diff', []);
    expect(approved).toBe(true);
    const items = s.svc.inventoryList();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ jobId: 1, toolName: 'word_count', origin: 'registry', tag: 'evolve/1' });
    expect(s.saved()).toHaveLength(1); // 永続化された
  });

  it('verified: 未検証候補は個別カード(理由つき)になり、タイムアウトで辞退扱い', async () => {
    const s = makeService({
      fetchFn: registryFetch(routes({ verified: false })),
      timeoutMs: 60, // テスト用に短縮
    });
    const r = await search(s.svc, 'verified'); // respond しない → タイムアウト
    expect(r.outcome).toBe('declined');
    expect(s.requested).toHaveLength(1);
    expect(s.requested[0]!.warnings.some((w) => w.includes('未検証のため、包括承認の範囲外'))).toBe(true);
    expect(s.enqueue).not.toHaveBeenCalled();
  });

  it('verified: 危険権限(network)持ちは検証済みでも個別カードになり、許可しても仮導入ではない', async () => {
    const s = makeService({
      fetchFn: registryFetch(routes({ code: CODE_NETWORK, manifest: manifestJson({ network: true }) })),
    });
    s.respond('allow');
    const r = await search(s.svc, 'verified');
    expect(r.outcome).toBe('imported');
    expect(s.requested).toHaveLength(1);
    expect(s.requested[0]!.warnings.some((w) => w.includes('危険権限'))).toBe(true);
    // 事前登録されていない → 昇格は人間承認待ち(自動 true にならない)
    let resolved: boolean | null = null;
    void s.hooks().requestPromotionApproval(toolJob(), 'diff', []).then((v) => (resolved = v));
    await new Promise((r2) => setTimeout(r2, 50));
    expect(resolved).toBeNull();
    expect(s.svc.inventoryList()).toHaveLength(0);
    s.svc.evolutionPromoteRespond(1, true); // 後始末
  });
});

describe('M29-5: 昇格フックの安全ガード', () => {
  it('危険警告つき・scope=core は事前登録済みでも自動承認されない', async () => {
    const s = makeService({ fetchFn: registryFetch(routes()) });
    await search(s.svc, 'verified'); // jobId=1 を登録

    // 危険警告つき → 人間承認待ちに落ちる
    let resolved: boolean | null = null;
    void s.hooks().requestPromotionApproval(toolJob(), 'diff', ['child_processを使用']).then((v) => (resolved = v));
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBeNull();
    expect(s.svc.inventoryList()).toHaveLength(0);
    s.svc.evolutionPromoteRespond(1, false);

    // 登録は1回で消費される(未登録のジョブは常に人間承認待ち)
    let resolved2: boolean | null = null;
    void s.hooks().requestPromotionApproval(toolJob({ id: 99 }), 'diff', []).then((v) => (resolved2 = v));
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved2).toBeNull();
    s.svc.evolutionPromoteRespond(99, false);
  });

  it('verified-generate: 生成ジョブ(scope=tool)が仮導入候補に登録される。verified では登録されない', async () => {
    for (const [scope, expectAuto] of [
      ['verified-generate', true],
      ['verified', false],
    ] as const) {
      const s = makeService({ fetchFn: registryFetch({}) }); // レジストリは空(生成のみ)
      s.svc.setAutonomous(true, scope);
      const inner = s.svc as unknown as {
        current: unknown;
        evolutionContext: (o?: unknown) => { requestCapability: (d: string, e: string) => Promise<{ jobId: number }> };
      };
      const { jobId } = await inner.evolutionContext(inner.current).requestCapability('新ツール', 'in->out');
      expect(jobId).toBe(1);
      const approvalP = s.hooks().requestPromotionApproval(toolJob(), 'diff', []);
      if (expectAuto) {
        expect(await approvalP).toBe(true);
        expect(s.svc.inventoryList()[0]).toMatchObject({ origin: 'generated' });
      } else {
        let resolved: boolean | null = null;
        void approvalP.then((v) => (resolved = v));
        await new Promise((r) => setTimeout(r, 50));
        expect(resolved).toBeNull();
        s.svc.evolutionPromoteRespond(1, false);
      }
    }
  });
});

describe('M29-5: 棚卸し(残す/削除)と永続化', () => {
  const seed: ProvisionalInstall[] = [
    { jobId: 5, toolName: 'word_count', origin: 'registry', tag: 'evolve/5', installedAt: '2026-07-11T00:00:00Z' },
  ];

  it('残す: リストから外れ、アンインストールは呼ばれない', async () => {
    const s = makeService({ seed });
    expect(s.svc.inventoryList()).toHaveLength(1); // 永続化からの再提示
    const r = await s.svc.inventoryResolve(5, true);
    expect(r.ok).toBe(true);
    expect(s.svc.inventoryList()).toHaveLength(0);
    expect(s.uninstall).not.toHaveBeenCalled();
    expect(s.saved()).toHaveLength(0);
  });

  it('削除: uninstallPromotion が呼ばれ、成功でリストから外れる。失敗なら残る', async () => {
    const s = makeService({ seed, uninstall: async () => ({ ok: false, message: 'conflict' }) });
    const fail = await s.svc.inventoryResolve(5, false);
    expect(fail.ok).toBe(false);
    expect(s.svc.inventoryList()).toHaveLength(1); // 失敗時は残す

    const s2 = makeService({ seed });
    const okR = await s2.svc.inventoryResolve(5, false);
    expect(okR.ok).toBe(true);
    expect(s2.uninstall).toHaveBeenCalledWith(5);
    expect(s2.svc.inventoryList()).toHaveLength(0);
  });

  it('仮導入したジョブの rolled_back / failed でリストから自動除去される', () => {
    const s = makeService({ seed });
    s.hooks().onEvent({
      kind: 'job_update',
      job: { id: 5, description: 'x', status: 'rolled_back', log: [], gates: [] },
    });
    expect(s.svc.inventoryList()).toHaveLength(0);
    expect(s.saved()).toHaveLength(0);
  });
});
