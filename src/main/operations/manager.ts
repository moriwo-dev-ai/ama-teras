import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  AdapterStatusInfo,
  AppConfig,
  ApprovalBatchItem,
  CommunityCandidate,
  IwatoRequestPayload,
  MediaStrategyEntry,
  MetricsSnapshot,
  OperationsConfig,
  OperationsDraft,
  ProjectProfile,
  RegistryGodInfo,
  RegistryMatchRef,
  TriageCard,
} from '../../shared/types';
import {
  bulkGroupKey,
  firstUrl,
  hasUnresolvedPlaceholder,
  hatenaPanelUrl,
  isLinkOnlyAdapter,
  marksDraftPosted,
  mediaOf,
  nextVersion,
  repoUrl,
  resolvePostText,
  sameVersion,
  xIntentUrl,
  type BulkItemResult,
  type BulkRespondResult,
} from '../../shared/operations';
import type { LLMProvider } from '../providers/types';
import {
  createBlueskyAdapter,
  parseBlueskyCredentials,
  BlueskyReader,
  type BlueskyPost,
} from './adapters/bluesky';
import { createGithubAdapter, defaultGhRunner, detectGhPath, GithubReader, type GhRunner } from './adapters/github';
import { createHatenaAdapter, HatenaReader } from './adapters/hatena';
import { createRepoVersionAdapter, readPackageVersion, versionFromTag } from './adapters/repoVersion';
import { createHnAdapter, fetchItem, fetchUserKarma, HnReader, type HnStory } from './adapters/hn';
import { createXAdapter, buildXSearchSuggestions, type XSearchSuggestion } from './adapters/x';
import { createZennAdapter, ZennReader, type FetchLike } from './adapters/zenn';
import {
  articleSlug,
  buildArticleMarkdown,
  createZennRepoAdapter,
  defaultGitRunner,
  type GitRunner,
} from './adapters/zennRepo';
import {
  buildArticleOutlinePrompt,
  buildCandidatePrompt,
  buildHighlightPrompt,
  CandidateStore,
  DraftStore,
  parseCandidate,
  parseDrafts,
  strategyBoard,
} from './amenoUzume';
import { computeImpacts, summarize, type ImpactEntry } from './impact';
import { Inbox } from './inbox';
import {
  buildApprovalBatch,
  buildKamuhakariPrompt,
  classifyParamChange,
  parseKamuhakariOutput,
  reclassifyBudgetChange,
  type ApprovalBatch,
  type ParamChange,
} from './kamuhakari';
import { completeText, completeTextWithUsage } from './llm';
import { OmoiKami } from './omoiKami';
import { IwatoGate, type IwatoAuditEvent } from './protocol';
import { GodRegistry, type GodDefinition } from './gods';
import { GodScheduler, type GodClockJob } from './scheduler';
import { OpsThread, type OpsThreadMessage } from './thread';
import { triageRepo } from './tedikaRao';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * M32: 運営マネージャ(Project TAKAMA-gahara の配線)。
 * オーナーモード(config.operations.enabled)がOFFの間は何も初期化しない
 * (ユーザー指示 2026-07-11: OFF時はgh検出・収集も動かさない)。
 */

export interface OperationsManagerDeps {
  userDataDir: string;
  getConfig: () => AppConfig;
  audit: (event: IwatoAuditEvent) => void;
  /** 岩戸ゲートの承認ダイアログ(renderer への橋渡しは ipc.ts が注入) */
  approvalPrompt: (req: IwatoRequestPayload) => Promise<boolean>;
  /** LLM帯の取得(service注入。string=キー未設定メッセージ)。神エージェントは worker/explorer */
  bandProvider: (band: 'planner' | 'reviewer' | 'worker' | 'explorer') => LLMProvider | string;
  /**
   * M34-7: 運営専用モデル帯(kamuhakariBand/godsBand)を解決したプロバイダ。
   * 未設定時は従来帯(planner/worker)へフォールバックし、usage集計は
   * 'kamuhakari'/'gods' ラベルで区別される。未注入時は bandProvider で代行
   */
  roleProvider?: (role: 'kamuhakari' | 'gods') => LLMProvider | string;
  /** M35-4: Bluesky実行系の資格情報(secrets 'bluesky' スロットのJSON)。未注入/未設定=提案のみ */
  getBlueskySecret?: () => string | null;
  /**
   * M38-2: 承認済みの能力ギャップ(branch='evolve')を進化ジョブとして起票する。
   * 起票の引き金は必ず「人間が承認バッチで承認した」ことで、神議が自分で起票することはない。
   * 昇格は従来どおり進化サブシステムの承認制(ここは起票までを自動化する配線)
   */
  enqueueEvolution?: (description: string, expectedIO: string) => Promise<number>;
  /**
   * M42-2: 「作る前に探す」を神議にも通す。神議は自律実行なので候補カードを見る人間がいない。
   * よって **探すだけ** をここで行い、取り込むかどうかは承認バッチで人間が決める
   */
  findRegistryPlugin?: (query: string) => Promise<RegistryMatchRef | null>;
  /** M42-2: 承認後の取り込み(ダウンロード→B環境の検証ゲート→昇格承認。ゲートは飛ばさない) */
  importRegistryPlugin?: (name: string) => Promise<{ ok: boolean; message: string; jobId?: number }>;
  /** M42-3: レジストリで配布されている神定義の検索 */
  listRegistryGods?: (query?: string) => Promise<RegistryGodInfo[]>;
  /** M42-3: 神定義JSONの取得(適用は必ず岩戸ゲートの god-definition executor 経由) */
  fetchRegistryGod?: (id: string) => Promise<unknown | null>;
  /** M46: 稼働中アプリの版(package.json)。リリースタグとの食い違い検出に使う */
  appVersion?: string;
  /** テスト用注入 */
  ghRunner?: GhRunner;
  /** M37: zenn-content への commit/push 実行(未注入=実git) */
  gitRunner?: GitRunner;
  fetchImpl?: FetchLike;
  /** workspace のPROGRESS.md/git logを読む(発信ドラフトの素材) */
  readHighlightSources?: () => Promise<{ progressExcerpt: string; recentCommits: string }>;
}

export interface OperationsStatus {
  enabled: boolean;
  ghDetected: boolean;
  ghPath: string | null;
  adapters: AdapterStatusInfo[];
  /** M37: 発信ドラフトの行き先候補(リリース先リポジトリ)としてUIが使う */
  repos: string[];
}

/** M33: 神ごとのパラメータ(キーワード・巡回済み記録・Issue差分基準)。userData/operations/god-params.json */
interface GodParams {
  keywords: string[];
  /** Bluesky巡回の重複排除: 評価済み投稿uri・評価済みhandle */
  seenUris: string[];
  seenHandles: string[];
  /** TEDIKA-rao差分チェックの既知Issue/PR番号(repo別) */
  knownIssues: Record<string, number[]>;
  /** M38-3: 効果測定を受け箱へ報告済みの下書きID(二重報告の防止)。任意=旧形式互換 */
  impactReported?: string[];
  /** M34-2: HN監視の既知状態(karma・スレッドのコメント総数・自コメントへの既知返信id)。任意=旧形式互換 */
  hnState?: {
    karma?: number;
    threadDescendants: Record<string, number>;
    ownCommentKids: Record<string, number[]>;
  };
}

const DEFAULT_GOD_PARAMS: GodParams = {
  keywords: ['AIエージェント 自作', 'self-evolving agent'],
  seenUris: [],
  seenHandles: [],
  knownIssues: {},
};

/** M33-5: 定義(gods/*.json)→時計ジョブへの写像 */
function jobFromDefinition(def: GodDefinition): GodClockJob {
  return {
    id: def.id,
    godId: def.id,
    intervalMin: def.clock.intervalMin ?? 720,
    ...(def.clock.dailyTimes !== undefined ? { dailyTimes: def.clock.dailyTimes } : {}),
    enabled: def.enabled,
    dailyTokenBudget: def.dailyTokenBudget,
    spentToday: 0,
  };
}

export class OperationsManager {
  private gate: IwatoGate | null = null;
  private github: GithubReader | null = null;
  private zenn: ZennReader;
  private bluesky: BlueskyReader;
  private omoi: OmoiKami | null = null;
  private drafts: DraftStore | null = null;
  private candidates: CandidateStore | null = null;
  private ghPath: string | null = null;
  private ghRun: GhRunner | null = null;
  private triageCache: TriageCard[] = [];
  private inbox: Inbox | null = null;
  private thread: OpsThread | null = null;
  private scheduler: GodScheduler | null = null;
  private gods: GodRegistry | null = null;
  private blueskyExecAvailable = false;

  private hn: HnReader;

  constructor(private readonly deps: OperationsManagerDeps) {
    this.zenn = new ZennReader(deps.fetchImpl);
    this.bluesky = new BlueskyReader(deps.fetchImpl);
    this.hn = new HnReader(deps.fetchImpl);
  }

  private opsConfig(): OperationsConfig {
    return this.deps.getConfig().operations ?? { enabled: false, repos: [], zennSlugs: [] };
  }

  /**
   * M41-3: 神々のプロンプトに渡すプロジェクト像。未設定なら観測対象リポジトリ名から推測し、
   * それも無ければ「このプロジェクト」。特定プロジェクト名のハードコードはしない
   */
  private project(): ProjectProfile {
    const cfg = this.opsConfig();
    const fromRepo = cfg.repos[0]?.split('/')[1];
    return {
      name: cfg.projectName?.trim() !== undefined && cfg.projectName.trim() !== '' ? cfg.projectName.trim() : (fromRepo ?? 'このプロジェクト'),
      description: cfg.projectDescription?.trim() !== undefined && cfg.projectDescription.trim() !== '' ? cfg.projectDescription.trim() : '(説明未設定。設定→接続→オーナーモードで書いておくと神々の下書き精度が上がる)',
    };
  }

  private get dir(): string {
    return join(this.deps.userDataDir, 'operations');
  }

  /** オーナーモードON時のみ初期化(冪等)。OFFなら false */
  private ensureInitialized(): boolean {
    if (!this.opsConfig().enabled) return false;
    if (this.gate !== null) return true;

    this.ghPath = detectGhPath();
    const run: GhRunner | null =
      this.deps.ghRunner ?? (this.ghPath !== null ? defaultGhRunner(this.ghPath) : null);
    if (run !== null) this.github = new GithubReader(run);
    this.ghRun = run; // M46: リリースの版取得(読み取り専用。発行は必ず岩戸ゲート経由)

    const gate = new IwatoGate(this.deps.approvalPrompt, this.deps.audit);
    if (run !== null) gate.register(createGithubAdapter(run, () => true));
    gate.register(createZennAdapter());
    gate.register(createXAdapter());
    // M35-4: 資格情報があれば実行系(post/follow/reply)が有効化される。
    // 実行は岩戸ゲート経由のみ(executorは登録時に封印される)
    const blueskyCreds = parseBlueskyCredentials(this.deps.getBlueskySecret?.() ?? null);
    gate.register(createBlueskyAdapter(blueskyCreds, this.deps.fetchImpl));
    this.blueskyExecAvailable = blueskyCreds !== null;
    gate.register(createHnAdapter());
    gate.register(createHatenaAdapter());
    // M37: Zenn記事のコミット先(zenn-content)。パス未設定でも登録はする
    // (availability=false で「設定へ」を案内する。実行時は executor が弾く)
    gate.register(
      createZennRepoAdapter(() => this.opsConfig().zennRepoDir ?? null, {
        run: this.deps.gitRunner ?? defaultGitRunner(),
      }),
    );
    // M47: リリース時に package.json の version を上げる(更新確認が壊れないように)。
    // 対象は作業中のリポジトリ(workspace)。executorは岩戸ゲートに封印される
    const workspace = this.deps.getConfig().workspace;
    if (workspace !== undefined && workspace !== '') {
      gate.register(createRepoVersionAdapter(workspace, this.deps.gitRunner ?? defaultGitRunner()));
    }

    // M33-5: 神の定義レジストリ+定義変更アダプタ。
    // 定義の新設・改造(組織図の自己改変)は岩戸ゲートの承認を通ったexecutorのみが
    // applyApproved に到達できる(protocol.ts の封印=承認バイパス不可)
    const gods = new GodRegistry(this.dir);
    gods.ensureDefaults();
    this.gods = gods;
    gate.register({
      id: 'god-definition',
      capabilities: { read: true, search: false, draft: false, execute: ['apply'] },
      compliance: '神の新設・改造(定義変更)は人間承認必須。適用前にスキーマ検証',
      executor: async (_action, params) => {
        const result = gods.applyApproved(params['definition']);
        if (!result.ok || result.def === undefined) throw new Error(result.detail);
        // 時計へ同期(新神はジョブ追加、既存は clock/budget/enabled を反映)
        if (this.scheduler !== null) {
          this.scheduler.ensureJobs([jobFromDefinition(result.def)]);
          this.scheduler.update(result.def.id, {
            intervalMin: result.def.clock.intervalMin ?? 720,
            enabled: result.def.enabled,
            dailyTokenBudget: result.def.dailyTokenBudget,
          });
        }
        return Promise.resolve(result.detail);
      },
    });
    this.gate = gate;

    this.omoi = new OmoiKami(this.dir, {
      github: this.github,
      zenn: this.zenn,
      hatena: new HatenaReader(this.deps.fetchImpl),
      ...(this.deps.fetchImpl !== undefined ? { fetchImpl: this.deps.fetchImpl } : {}),
    });
    this.drafts = new DraftStore(this.dir);
    this.candidates = new CandidateStore(this.dir);

    // M33: 受け箱・運営スレッド・神々の時計
    this.inbox = new Inbox(this.dir);
    this.inbox.migrateLegacy(this.drafts.list(), this.candidates.list());
    this.thread = new OpsThread(this.dir);
    this.scheduler = new GodScheduler(
      join(this.dir, 'schedule.json'),
      (godId) => this.runGod(godId),
      {
        onBudgetAlert: (job) => {
          this.inbox?.post({
            kind: 'budget-alert',
            godId: job.godId,
            title: `予算超過: ${job.godId}(本日${job.spentToday}tok)。間隔を${job.intervalMin}分へ自動拡大`,
            payload: { jobId: job.id, spentToday: job.spentToday, intervalMin: job.intervalMin },
          });
          this.thread?.post({
            role: 'system',
            kind: 'notice',
            body: `⚠ ${job.godId} が1日トークン予算を超過(${job.spentToday}tok)。実行間隔を${job.intervalMin}分へ自動拡大した(翌日復元)`,
          });
        },
        onJobRun: (job, result) => {
          this.deps.audit({
            kind: 'operations-execute',
            adapterId: `god:${job.godId}`,
            action: 'scheduled-run',
            target: 'inbox',
            approved: true,
            detail: `${result.ok ? 'ok' : 'fail'}: ${result.detail}(${result.tokensUsed}tok)`,
          });
        },
      },
    );
    this.scheduler.ensureJobs(gods.list().map(jobFromDefinition));
    this.scheduler.start();
    return true;
  }

  /** 設定変更(オーナーモードOFF化)で状態を破棄 */
  reset(): void {
    this.scheduler?.stop();
    this.gate = null;
    this.github = null;
    this.omoi = null;
    this.drafts = null;
    this.candidates = null;
    this.ghPath = null;
    this.triageCache = [];
    this.inbox = null;
    this.thread = null;
    this.scheduler = null;
    this.gods = null;
  }

  // ---- M33-5: 神の定義(宣言的データ)----

  godDefinitions(): GodDefinition[] {
    if (!this.ensureInitialized() || this.gods === null) return [];
    return this.gods.list();
  }

  /**
   * 定義変更の申請。適用は岩戸ゲートの承認ダイアログ
   * (何を・どこへ・全文=定義JSON)を通ったときだけ行われる
   */
  async requestGodDefinitionApply(definition: unknown): Promise<{ ok: boolean; detail: string }> {
    if (!this.ensureInitialized() || this.gate === null) {
      return { ok: false, detail: 'オーナーモードがOFF' };
    }
    const rec = typeof definition === 'object' && definition !== null ? (definition as Record<string, unknown>) : {};
    const id = String(rec['id'] ?? '(不明)');
    const isNew = this.gods?.get(id) === null;
    return this.gate.requestExecute(
      'god-definition',
      'apply',
      `神の定義: ${id}(${isNew ? '新設' : '改造'})`,
      JSON.stringify(definition, null, 1),
      { definition: definition as never },
    );
  }

  // ---- M33: 神パラメータ(キーワード・重複排除・差分基準) ----

  private get paramsPath(): string {
    return join(this.dir, 'god-params.json');
  }

  private loadParams(): GodParams {
    let params: GodParams;
    try {
      const parsed = JSON.parse(readFileSync(this.paramsPath, 'utf8')) as Partial<GodParams>;
      params = { ...DEFAULT_GOD_PARAMS, ...parsed };
    } catch {
      params = { ...DEFAULT_GOD_PARAMS };
    }
    // M41-3: ユーザーが設定でキーワードを与えていればそれを起点にする
    // (神議はここから自律調整していく。未設定なら従来どおり神議が育てた値)
    const configured = this.opsConfig().keywords?.filter((k) => k.trim() !== '') ?? [];
    if (configured.length > 0 && params.keywords === DEFAULT_GOD_PARAMS.keywords) {
      params = { ...params, keywords: configured };
    }
    return params;
  }

  private saveParams(params: GodParams): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      // 重複排除リストは直近2000件に丸める(無限成長の防止)
      writeFileSync(
        this.paramsPath,
        JSON.stringify(
          { ...params, seenUris: params.seenUris.slice(-2000), seenHandles: params.seenHandles.slice(-2000) },
          null,
          1,
        ),
        'utf8',
      );
    } catch {
      // ベストエフォート
    }
  }

  // ---- M33: 神々の定刻実行(T3)----

  private cheapLLM(): LLMProvider | string {
    // M34-7: 運営専用帯(godsBand)優先。未設定はworker帯へフォールバック(roleProvider内で解決)
    return this.deps.roleProvider?.('gods') ?? this.deps.bandProvider('worker');
  }

  private kamuhakariLLM(): LLMProvider | string {
    return this.deps.roleProvider?.('kamuhakari') ?? this.deps.bandProvider('planner');
  }

  private async runGod(godId: string): Promise<{ ok: boolean; detail: string; tokensUsed: number }> {
    if (this.inbox === null) return { ok: false, detail: '未初期化', tokensUsed: 0 };
    // M33-5: 定義(エンジン)でディスパッチ。定義が無い場合はid直指定(後方互換)
    const def = this.gods?.get(godId) ?? null;
    const engine = def?.engine ?? godId;
    try {
      if (engine === 'community-patrol') return await this.runUzumePatrol(def);
      if (engine === 'draft-writer') return await this.runUzumeDrafts();
      if (engine === 'issue-gatekeeper') return await this.runTedikaDiff();
      if (engine === 'metrics-observer' || godId === 'omoi-kami') {
        const snap = await this.collectSnapshot();
        if (snap === null) return { ok: false, detail: '収集失敗', tokensUsed: 0 };
        const stars = Object.values(snap.github).reduce((a, m) => a + m.stars, 0);
        const liked = Object.values(snap.zenn).reduce((a, m) => a + m.liked, 0);
        const hatena = Object.values(snap.hatena ?? {}).reduce((a, c) => a + c, 0);
        this.inbox.post({
          kind: 'metrics',
          godId,
          title: `観測: ★${stars} / Zenn♥${liked}${snap.hatena !== undefined ? ` / B!${hatena}` : ''}${snap.hn?.karma !== undefined ? ` / HN karma ${snap.hn.karma}` : ''}`,
          payload: { ts: snap.ts },
        });
        await this.watchHackerNews(snap.hn?.karma);
        // M38-3: 発信の効果測定(投稿→前後差分)。計測窓が閉じた投稿を1度だけ受け箱へ
        const reported = this.reportImpacts(godId);
        return {
          ok: true,
          detail: `スナップショット投函${reported > 0 ? `(効果測定${reported}件)` : ''}`,
          tokensUsed: 0,
        };
      }
      if (engine === 'kamuhakari' || godId === 'kamuhakari') {
        const result = await this.runKamuhakari();
        return { ok: true, detail: `神議完了(適用${result.appliedChanges.length}/バッチ${result.batch ? 1 : 0})`, tokensUsed: result.tokensUsed };
      }
      return { ok: false, detail: `未知の神: ${godId}`, tokensUsed: 0 };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), tokensUsed: 0 };
    }
  }

  /**
   * M34-2: HN監視(読み取りのみ・書き込みは実装しない)。
   * karma変化・登録スレッドの新コメント・自分のコメントへの返信(全文添付)を受け箱へ。
   * 既知状態は god-params.json の hnState(任意フィールド=旧形式互換)
   */
  private async watchHackerNews(currentKarma: number | undefined): Promise<void> {
    if (this.inbox === null) return;
    const cfg = this.opsConfig();
    if (cfg.hnUser === undefined && (cfg.hnThreads === undefined || cfg.hnThreads.length === 0)) return;
    const fetchImpl = this.deps.fetchImpl ?? ((url: string) => fetch(url));
    const params = this.loadParams();
    const state = params.hnState ?? { threadDescendants: {}, ownCommentKids: {} };

    // karma変化
    if (currentKarma !== undefined && state.karma !== undefined && currentKarma !== state.karma) {
      this.inbox.post({
        kind: 'metrics',
        godId: 'omoi-kami',
        title: `HN karma ${state.karma} → ${currentKarma}(${currentKarma > state.karma ? '⬆+' : '⬇'}${currentKarma - state.karma})`,
        payload: { karma: currentKarma },
      });
    }
    if (currentKarma !== undefined) state.karma = currentKarma;

    // 登録スレッドの新着コメント(descendants差分)
    for (const threadId of cfg.hnThreads ?? []) {
      const item = await fetchItem(fetchImpl, Number(threadId));
      if (item === null) continue;
      const known = state.threadDescendants[threadId];
      if (known !== undefined && item.descendants > known) {
        this.inbox.post({
          kind: 'hn-reply',
          godId: 'omoi-kami',
          title: `HNスレッド「${item.title.slice(0, 60)}」にコメント+${item.descendants - known}(計${item.descendants})`,
          payload: { threadId, url: `https://news.ycombinator.com/item?id=${threadId}` },
        });
      }
      state.threadDescendants[threadId] = item.descendants;
    }

    // 自分のコメントへの返信(submitted上位のcommentのkids差分→本文全文を添付)
    if (cfg.hnUser !== undefined) {
      const user = await fetchUserKarma(fetchImpl, cfg.hnUser);
      for (const itemId of (user?.submitted ?? []).slice(0, 15)) {
        const own = await fetchItem(fetchImpl, itemId);
        if (own === null || own.type !== 'comment' || own.by !== cfg.hnUser) continue;
        const knownKids = new Set(state.ownCommentKids[String(itemId)] ?? []);
        const newKids = own.kids.filter((k) => !knownKids.has(k));
        for (const kidId of newKids) {
          const reply = await fetchItem(fetchImpl, kidId);
          if (reply === null) continue;
          this.inbox.post({
            kind: 'hn-reply',
            godId: 'omoi-kami',
            title: `HN: あなたのコメントに @${reply.by} が返信`,
            payload: {
              url: `https://news.ycombinator.com/item?id=${kidId}`,
              fullText: reply.text.slice(0, 4000),
              inReplyTo: own.text.slice(0, 500),
            },
          });
        }
        state.ownCommentKids[String(itemId)] = own.kids;
      }
    }
    this.saveParams({ ...params, hnState: state });
  }

  /** AMENO-uzume 巡回(1時間ごと): Bluesky検索→未評価のみ安い帯で目利き→候補+受け箱 */
  private async runUzumePatrol(def: GodDefinition | null = null): Promise<{ ok: boolean; detail: string; tokensUsed: number }> {
    if (this.candidates === null || this.inbox === null) return { ok: false, detail: '未初期化', tokensUsed: 0 };
    const params = this.loadParams();
    const provider = this.cheapLLM();
    if (typeof provider === 'string') return { ok: false, detail: provider, tokensUsed: 0 };
    // M33-5: 定義のjudgePrompt上書き(変更は人間承認済みのもののみここに届く)
    const judgePrompt = (pasted: string): string =>
      def?.judgePrompt !== undefined
        ? `${def.judgePrompt}\n\n# 貼り付けテキスト\n${pasted.slice(0, 4000)}\n\n# 出力(JSONのみ)\n{"verdict":"match"|"no-match"|"unclear","reasons":["…"],"replyDraft":"matchの場合のみ"}`
        : buildCandidatePrompt(pasted);

    let tokensUsed = 0;
    let evaluated = 0;
    let matched = 0;
    const seenUris = new Set(params.seenUris);
    const seenHandles = new Set(params.seenHandles);
    for (const keyword of params.keywords.slice(0, 4)) {
      const posts = await this.bluesky.searchPosts(keyword, 10);
      for (const post of posts) {
        if (seenUris.has(post.uri) || seenHandles.has(post.handle)) continue; // 重複排除
        seenUris.add(post.uri);
        seenHandles.add(post.handle);
        if (evaluated >= 5) break; // 1回の巡回で評価は最大5件(予算保護)
        evaluated++;
        const pasted = `@${post.handle} (${post.author})\n${post.text}`;
        const { text, tokensUsed: t } = await completeTextWithUsage(
          provider,
          'あなたはコミュニティ担当。',
          judgePrompt(pasted),
        );
        tokensUsed += t;
        const parsed = parseCandidate(text, `bluesky:${keyword}`, pasted);
        if (parsed !== null && parsed.verdict === 'match') {
          const saved = this.candidates.add(parsed);
          matched++;
          this.inbox.post({
            kind: 'candidate',
            godId: 'ameno-uzume',
            title: `仲間候補: @${post.handle}`,
            payload: { candidateId: saved.id, keyword },
          });
        }
      }
    }
    this.saveParams({ ...params, seenUris: [...seenUris], seenHandles: [...seenHandles] });
    return { ok: true, detail: `巡回完了(評価${evaluated}/候補${matched})`, tokensUsed };
  }

  /** AMENO-uzume 下書き(1日1回): worker帯で見せ場→下書き→受け箱 */
  private async runUzumeDrafts(): Promise<{ ok: boolean; detail: string; tokensUsed: number }> {
    if (this.drafts === null || this.omoi === null || this.inbox === null) return { ok: false, detail: '未初期化', tokensUsed: 0 };
    const provider = this.cheapLLM();
    if (typeof provider === 'string') return { ok: false, detail: provider, tokensUsed: 0 };
    const sources = (await this.deps.readHighlightSources?.()) ?? { progressExcerpt: '', recentCommits: '' };
    const { current, previous } = this.omoi.latestPair();
    const { text, tokensUsed } = await completeTextWithUsage(
      provider,
      'あなたはOSSの広報担当。',
      buildHighlightPrompt({ ...sources, current, previous, project: this.project() }),
    );
    const created = this.drafts.add(parseDrafts(text));
    for (const d of created) {
      this.inbox.post({ kind: 'draft', godId: 'ameno-uzume', title: `下書き: ${d.title}`, payload: { draftId: d.id, draftKind: d.kind } });
    }
    return { ok: true, detail: `下書き${created.length}件`, tokensUsed };
  }

  /** TEDIKA-rao(1時間ごと): Issue/PRの差分チェック→新着のみトリアージ→受け箱 */
  private async runTedikaDiff(): Promise<{ ok: boolean; detail: string; tokensUsed: number }> {
    if (this.github === null || this.inbox === null) return { ok: false, detail: 'gh未検出', tokensUsed: 0 };
    const provider = this.cheapLLM();
    if (typeof provider === 'string') return { ok: false, detail: provider, tokensUsed: 0 };
    const params = this.loadParams();
    let tokensUsed = 0;
    let newCount = 0;
    for (const repo of this.opsConfig().repos) {
      const items = await this.github.openItems(repo);
      const known = new Set(params.knownIssues[repo] ?? []);
      const fresh = items.filter((i) => !known.has(i.number));
      params.knownIssues[repo] = items.map((i) => i.number);
      if (fresh.length === 0) continue;
      const llm = async (prompt: string): Promise<string> => {
        const r = await completeTextWithUsage(provider, 'あなたはOSSの門番レビュアー。', prompt);
        tokensUsed += r.tokensUsed;
        return r.text;
      };
      // triageRepo は全件対象なので、新着のみ直接カード化する
      for (const item of fresh.slice(0, 5)) {
        const diff = item.kind === 'pr' ? await this.github.prDiff(repo, item.number) : null;
        const { buildTriagePrompt, parseTriage } = await import('./tedikaRao');
        const card = parseTriage(await llm(buildTriagePrompt(item, diff)), repo, item);
        if (card !== null) {
          this.triageCache = [...this.triageCache.filter((c) => !(c.repo === repo && c.number === card.number)), card];
          newCount++;
          this.inbox.post({
            kind: 'triage',
            godId: 'tedika-rao',
            title: `新着${card.kind === 'pr' ? 'PR' : 'Issue'}: ${repo}#${card.number} ${card.title}`,
            payload: { repo, number: card.number, recommendation: card.recommendation },
          });
        }
      }
    }
    this.saveParams(params);
    return { ok: true, detail: `新着${newCount}件をトリアージ`, tokensUsed };
  }

  // ---- M33-4: 神議(T4)----

  /** 神議の自律適用(2段階制の autonomous 側)。承認必須側は呼ばないこと */
  private applyAutonomousChange(change: ParamChange): string {
    if (this.scheduler === null) return '未初期化';
    if (change.kind === 'interval') {
      const min = typeof change.value === 'number' ? change.value : Number.NaN;
      if (!Number.isFinite(min)) return '不正な間隔値(未適用)';
      const updated = this.scheduler.update(this.jobIdForGod(change.godId), { intervalMin: min });
      return updated ? `間隔を${updated.intervalMin}分に変更(クランプ済み)` : '対象ジョブなし';
    }
    if (change.kind === 'pause' || change.kind === 'resume') {
      const updated = this.scheduler.update(this.jobIdForGod(change.godId), { enabled: change.kind === 'resume' });
      return updated ? `${change.kind === 'pause' ? '一時停止' : '再開'}した` : '対象ジョブなし';
    }
    if (change.kind === 'budget-decrease') {
      const value = typeof change.value === 'number' ? change.value : Number.NaN;
      if (!Number.isFinite(value) || value < 0) return '不正な予算値(未適用)';
      // M36-1: ユーザーが手動設定した予算は神議の自律調整(引き下げ含む)より優先
      const target = this.scheduler.list().find((j) => j.id === this.jobIdForGod(change.godId));
      if (target?.budgetSetByUser === true) {
        return 'ユーザーが手動設定した予算のため自律変更しない(変更したい場合は承認バッチへ)';
      }
      const updated = this.scheduler.update(this.jobIdForGod(change.godId), { dailyTokenBudget: value });
      return updated ? `予算を${value}tokへ引き下げた` : '対象ジョブなし';
    }
    if (change.kind === 'keywords') {
      const keywords = Array.isArray(change.value) ? (change.value as unknown[]).map(String).filter((k) => k.trim() !== '').slice(0, 8) : [];
      if (keywords.length === 0) return '不正なキーワード(未適用)';
      const params = this.loadParams();
      this.saveParams({ ...params, keywords });
      return `巡回キーワードを更新: ${keywords.join(', ')}`;
    }
    // tool-toggle / rate-limit は v1では対象機構が未実装のため記録のみ
    return `記録のみ(${change.kind} はv1未対応)`;
  }

  private jobIdForGod(godId: string): string {
    // 神id=ジョブid(uzumeのみ2ジョブ。指定が曖昧なら巡回側)
    if (godId === 'ameno-uzume') return 'uzume-patrol';
    return godId;
  }

  /** 神議の実行(定刻/手動)。分析→自律適用→承認バッチ→運営スレッドへ投函 */
  async runKamuhakari(): Promise<{ analysis: string; appliedChanges: { change: ParamChange; detail: string }[]; batch: ApprovalBatch | null; tokensUsed: number }> {
    if (!this.ensureInitialized() || this.inbox === null || this.thread === null || this.omoi === null || this.drafts === null || this.scheduler === null) {
      return { analysis: '', appliedChanges: [], batch: null, tokensUsed: 0 };
    }
    const provider = this.kamuhakariLLM();
    if (typeof provider === 'string') {
      this.thread.post({ role: 'system', kind: 'notice', body: `神議を開けない: ${provider}` });
      return { analysis: '', appliedChanges: [], batch: null, tokensUsed: 0 };
    }

    const unread = this.inbox.unread();
    const params = this.loadParams();
    const prompt = buildKamuhakariPrompt({
      unread,
      history: this.omoi.history(14),
      postedDrafts: this.drafts.list().filter((d) => d.status === 'posted'),
      jobs: this.scheduler.list(),
      currentKeywords: params.keywords,
      project: this.project(),
    });
    const { text, tokensUsed } = await completeTextWithUsage(provider, 'あなたは運営戦略会議「神議」。', prompt, 8192);
    const parsed = parseKamuhakariOutput(text);
    if (parsed === null) {
      this.thread.post({ role: 'system', kind: 'notice', body: '神議の出力を解釈できなかった(次回に持ち越し)' });
      return { analysis: '', appliedChanges: [], batch: null, tokensUsed };
    }

    // 2段階制: 予算変更は実値で再分類 → 自律側のみ即適用
    const appliedChanges: { change: ParamChange; detail: string }[] = [];
    const approvalChanges: ParamChange[] = [];
    for (const raw of parsed.paramChanges) {
      const currentBudget = this.scheduler.list().find((j) => j.id === this.jobIdForGod(raw.godId))?.dailyTokenBudget ?? 0;
      const change = reclassifyBudgetChange(raw, currentBudget);
      if (classifyParamChange(change) === 'autonomous') {
        const detail = this.applyAutonomousChange(change);
        appliedChanges.push({ change, detail });
        this.deps.audit({
          kind: 'operations-execute',
          adapterId: 'god:kamuhakari',
          action: `param:${change.kind}`,
          target: change.godId,
          approved: true,
          detail: `${change.reason} → ${detail}`,
        });
      } else {
        approvalChanges.push(change);
      }
    }

    let batch = buildApprovalBatch(parsed.analysis, approvalChanges, parsed.proposals);

    // M35-4: 仲間候補のフォロー提案(LLM任せにせず決定的に生成)。承認→岩戸ゲート→実行の結線
    if (this.blueskyExecAvailable && this.candidates !== null) {
      const newMatches = this.candidates
        .list()
        .filter((c) => c.status === 'new' && c.verdict === 'match' && c.source.startsWith('bluesky'))
        .slice(0, 3);
      const followItems = newMatches
        .map((c) => {
          const handle = /^@([\w.:-]+)/.exec(c.profile)?.[1];
          if (handle === undefined) return null;
          return {
            id: randomUUID(),
            kind: 'exec-action' as const,
            title: `Bluesky: @${handle} をフォロー(仲間候補)`,
            detail: c.reasons.join(' / '),
            action: {
              adapterId: 'bluesky',
              actionName: 'follow',
              target: `@${handle}`,
              preview: `Blueskyで @${handle} をフォローする(自動化は承認制で運用)`,
              params: { handle },
            },
            status: 'pending' as const,
          };
        })
        .filter((i): i is NonNullable<typeof i> => i !== null);
      if (followItems.length > 0) {
        if (batch === null) {
          batch = { id: randomUUID(), ts: new Date().toISOString(), analysis: parsed.analysis, items: followItems };
        } else {
          batch.items.push(...followItems);
        }
      }
    }

    // M39: 未投稿の発信ドラフトを「行き先つき」で承認バッチに載せる(決定的生成)。
    // 一括承認すると、媒体ごとにできる限界まで進む(X=投稿画面を開く / Bluesky=API投稿 /
    // Zenn=published:falseでコミット / GitHub=下書きリリース)
    const draftItems = this.buildDraftProposals();
    if (draftItems.length > 0) {
      if (batch === null) {
        batch = { id: randomUUID(), ts: new Date().toISOString(), analysis: parsed.analysis, items: draftItems };
      } else {
        batch.items.push(...draftItems);
      }
    }
    // M42-2/3: 「作る前に探す」。生成/新設の提案にレジストリの既存を突き合わせ、
    // 見つかったら承認バッチの項目自体を「取り込み提案」に変える(判断は人間のまま)
    if (batch !== null) await this.enrichWithRegistry(batch);
    if (batch !== null) this.thread.addBatch(batch);

    // 運営スレッドへ: 分析+自律適用の通知+承認バッチ(1枚)
    const appliedNote = appliedChanges.length > 0
      ? `\n\n自律調整(即適用・記録済み):\n${appliedChanges.map((a) => `- [${a.change.godId}] ${a.change.kind}: ${a.change.reason} → ${a.detail}`).join('\n')}`
      : '';
    this.thread.post({ role: 'kamuhakari', kind: 'text', body: `${parsed.analysis}${appliedNote}` });
    if (batch !== null) {
      this.thread.post({ role: 'kamuhakari', kind: 'approval-batch', body: `承認バッチ(${batch.items.length}件)`, batchId: batch.id });
    }
    this.inbox.markRead(unread.map((u) => u.id));
    this.inbox.post({ kind: 'kamuhakari-report', godId: 'kamuhakari', title: `神議: 適用${appliedChanges.length}件/承認待ち${batch?.items.length ?? 0}件`, payload: {} });
    return { analysis: parsed.analysis, appliedChanges, batch, tokensUsed };
  }

  /**
   * M42-2/3: 能力ギャップの提案に、レジストリの既存(ツール/神)を突き合わせる。
   * レジストリ不達・候補なしは何もしない(従来どおり生成/新設の提案として残る)。
   * ここでは取り込まない — 取り込みは人間が承認バッチで承認したときだけ
   */
  private async enrichWithRegistry(batch: ApprovalBatch): Promise<void> {
    for (const item of batch.items) {
      if (item.kind !== 'capability-gap' || item.gap === undefined) continue;
      const query = `${item.title} ${item.detail}`;
      if (item.gap.branch === 'evolve' && this.deps.findRegistryPlugin !== undefined) {
        const hit = await this.deps.findRegistryPlugin(query).catch(() => null);
        if (hit !== null) {
          item.gap.registry = hit;
          item.title = `[レジストリに既存] ${item.title}`;
          item.detail =
            `${item.detail}\n\n📦 コミュニティに既存のツールがあります: ${hit.displayName}@${hit.version}` +
            `(${hit.verified ? '✅ 検証済み' : '⚠ 未検証'} / 作者: ${hit.author || '不明'})\n${hit.description}\n` +
            `承認すると **新規生成ではなく取り込み** に進みます(B環境: typecheck→テスト→スモーク → 昇格承認)`;
        }
      }
      if (item.gap.branch === 'new-god' && this.deps.listRegistryGods !== undefined) {
        const hit = (await this.deps.listRegistryGods(query).catch(() => []))[0];
        if (hit !== undefined) {
          item.gap.godRegistry = {
            key: hit.id,
            displayName: hit.name,
            description: hit.description,
            version: hit.version,
            author: hit.author,
            verified: hit.verified,
          };
          item.title = `[レジストリに既存] ${item.title}`;
          item.detail =
            `${item.detail}\n\n⛩ コミュニティに既存の神がいます: ${hit.name}(${hit.id} / engine=${hit.engine})` +
            `(${hit.verified ? '✅ 検証済み' : '⚠ 未検証'} / 作者: ${hit.author || '不明'})\n${hit.description}\n` +
            `承認すると **その定義をダウンロードし、岩戸ゲートで全文を確認してから** 迎え入れます`;
        }
      }
    }
  }

  /** M42-3: レジストリで配布されている神の一覧(運営タブの「レジストリから神を迎える」) */
  async godRegistryList(query?: string): Promise<RegistryGodInfo[]> {
    if (this.deps.listRegistryGods === undefined) return [];
    return this.deps.listRegistryGods(query).catch(() => []);
  }

  /**
   * M42-3: レジストリの神を迎える。定義JSONを取得 → 岩戸ゲート(全文確認)→ 適用。
   * ダウンロードしただけで有効化されることはない(承認が無ければ executor に届かない)
   */
  async installGodFromRegistry(id: string): Promise<{ ok: boolean; detail: string }> {
    if (this.deps.fetchRegistryGod === undefined) return { ok: false, detail: 'レジストリが無効' };
    const def = await this.deps.fetchRegistryGod(id).catch(() => null);
    if (def === null || def === undefined) return { ok: false, detail: `レジストリから「${id}」を取得できなかった` };
    return this.requestGodDefinitionApply(def);
  }

  /** M42-3: 自分の神の定義JSON(レジストリへPRするため人間が書き出す)。秘密は含まない */
  godDefinitionExport(id: string): string | null {
    const def = this.gods?.get(id) ?? null;
    return def === null ? null : JSON.stringify(def, null, 2);
  }

  /**
   * M39: 未投稿ドラフト → 承認バッチ項目(行き先つき)。種類ごとの行き先はコードで固定
   * (M37のUI表と同じ規則。Xの文字数に合わない種類をXへ流さない)。
   * ここは提案の生成のみ — 実行は必ず承認 → 岩戸ゲート(またはリンクを人間が開く)を通る
   */
  private buildDraftProposals(): ApprovalBatchItem[] {
    if (this.drafts === null) return [];
    const cfg = this.opsConfig();
    const items: ApprovalBatchItem[] = [];
    const url = this.projectUrl();
    // M43-1: 提案の時点で {URL} を解決する(承認ダイアログに出す全文=実際に出る全文)
    const pending = this.drafts
      .list()
      .filter((d) => d.status === 'draft')
      .map((d) => ({ ...d, body: resolvePostText(d.body, url) }));

    for (const d of pending.slice(0, 10)) {
      const base = { id: randomUUID(), kind: 'exec-action' as const, status: 'pending' as const };
      if (d.kind === 'x-post') {
        items.push({
          ...base,
          title: `X: 投稿画面を開く「${d.title}」`,
          detail: '規約上、アプリからは投稿しない(投稿ボタンはあなたが押す)',
          action: {
            adapterId: 'x',
            actionName: 'open-intent',
            target: `X 投稿画面「${d.title}」`,
            preview: d.body,
            params: { url: xIntentUrl(d.body), draftId: d.id },
          },
        });
        const url = firstUrl(d.body);
        if (url !== null) {
          items.push({
            ...base,
            id: randomUUID(),
            title: `はてブ: 追加画面を開く(${url})`,
            detail: '追加ボタンはあなたが押す(アプリからは発行しない)',
            action: {
              adapterId: 'hatena',
              actionName: 'add',
              target: `はてブ追加画面(${url})`,
              preview: url,
              params: { url: hatenaPanelUrl(url), draftId: d.id },
            },
          });
        }
        // Blueskyは規約上APIで投稿できる。300字以内のものだけ提案(超過は分割が必要=人間判断)
        if (this.blueskyExecAvailable && [...d.body].length <= 300) {
          items.push({
            ...base,
            id: randomUUID(),
            title: `Bluesky: 投稿「${d.title}」`,
            detail: '承認後、岩戸ゲートを経てAPIで投稿する',
            action: {
              adapterId: 'bluesky',
              actionName: 'post',
              target: `Bluesky 投稿「${d.title}」`,
              preview: d.body,
              params: { text: d.body, draftId: d.id },
            },
          });
        }
        continue;
      }
      if (d.kind === 'release-note') {
        const tag = /v\d+\.\d+\.\d+/.exec(d.body)?.[0] ?? /v\d+\.\d+\.\d+/.exec(d.title)?.[0];
        const repo = cfg.repos[0];
        if (tag !== undefined && repo !== undefined) {
          items.push({
            ...base,
            title: `GitHub Release(下書き): ${repo} ${tag}`,
            detail: '公開(publish)はGitHub上であなたが行う。作成は必ず下書き',
            action: {
              adapterId: 'github',
              actionName: 'release',
              target: `${repo} のリリース ${tag}(下書き)`,
              preview: `# ${d.title}\n\n${d.body}`,
              params: { repo, tag, title: d.title, body: d.body, draftId: d.id },
            },
          });
        }
        continue;
      }
      if (d.kind === 'article-outline' && (cfg.zennRepoDir ?? '') !== '') {
        items.push({
          ...base,
          title: `Zenn記事化: 「${d.title}」`,
          detail: '承認時に本文をLLMが起こし、全文を岩戸ダイアログで見せる。published: false でコミット',
          action: {
            adapterId: 'zenn-repo',
            actionName: 'commit-article',
            target: `zenn-content/articles/(${d.title})`,
            // 本文は承認直前に生成する(ここではアウトラインを見せる)
            preview: d.body,
            params: { draftId: d.id },
          },
        });
      }
    }
    return items;
  }

  /**
   * M40: 神を今すぐ1回動かす(デスクトップの各神ボタン相当をリモートからも押せるように)。
   * 予算・時計はそのまま(定刻実行の予定は変えない)
   */
  async runGodNow(godId: string): Promise<{ ok: boolean; detail: string; tokensUsed: number }> {
    if (!this.ensureInitialized()) return { ok: false, detail: 'オーナーモードがOFF', tokensUsed: 0 };
    return this.runGod(godId);
  }

  // ---- M33: UI用アクセサ ----

  clocks(): GodClockJob[] {
    if (!this.ensureInitialized() || this.scheduler === null) return [];
    return this.scheduler.list();
  }

  updateClock(
    id: string,
    patch: { intervalMin?: number; enabled?: boolean; dailyTokenBudget?: number; budgetSetByUser?: boolean },
  ): GodClockJob | null {
    if (!this.ensureInitialized() || this.scheduler === null) return null;
    // M36-1: この入口はUI(=ユーザー自身の設定行為)。引き上げも承認不要で、
    // 以後の神議の自律予算調整より優先される
    return this.scheduler.update(id, patch, { byUser: true });
  }

  inboxList(limit = 100): ReturnType<Inbox['list']> {
    if (!this.ensureInitialized() || this.inbox === null) return [];
    return this.inbox.list(limit);
  }

  inboxMarkRead(ids: string[]): void {
    if (!this.ensureInitialized() || this.inbox === null) return;
    this.inbox.markRead(ids);
  }

  threadList(): OpsThreadMessage[] {
    if (!this.ensureInitialized() || this.thread === null) return [];
    return this.thread.list();
  }

  threadBatches(): ApprovalBatch[] {
    if (!this.ensureInitialized() || this.thread === null) return [];
    return this.thread.listBatches();
  }

  threadPendingCount(): number {
    if (!this.ensureInitialized() || this.thread === null) return 0;
    return this.thread.pendingCount();
  }

  /** ユーザーの発言(⛩運営スレッド)。planner帯で神議が即応する */
  async threadSend(text: string): Promise<OpsThreadMessage[]> {
    if (!this.ensureInitialized() || this.thread === null) return [];
    this.thread.post({ role: 'user', kind: 'text', body: text });
    const provider = this.kamuhakariLLM();
    if (typeof provider === 'string') {
      this.thread.post({ role: 'system', kind: 'notice', body: provider });
      return this.thread.list();
    }
    const context = this.thread
      .list(20)
      .map((m) => `${m.role}: ${m.body.slice(0, 500)}`)
      .join('\n');
    const clocks = this.clocks()
      .map((j) => `- ${j.godId}: ${j.enabled ? '稼働' : '停止'} 間隔${j.intervalMin}分 予算${j.dailyTokenBudget}`)
      .join('\n');
    const { text: reply } = await completeTextWithUsage(
      provider,
      'あなたはAMA-teras運営の相談役(神議)。簡潔に日本語で答える。パラメータ変更の依頼には「次回の神議で反映する」と伝える(即時変更はできない)。外部発信は岩戸ゲート承認が必要と案内する。',
      `# 神々の時計\n${clocks}\n\n# 直近の会話\n${context}\n\n# ユーザーの発言\n${text}\n\n返答:`,
    );
    this.thread.post({ role: 'kamuhakari', kind: 'text', body: reply.trim() });
    return this.thread.list();
  }

  /**
   * M39: 同種(媒体×アクション)の複数項目を一括で応答する。
   * - 実行系(Bluesky/GitHub/Zenn): 岩戸ゲートの1ダイアログに全件の全文を並べ、承認後に1件ずつ実行。
   *   1件失敗しても残りは続行し「N件中M件成功」を返す(部分成功を成功に見せない)
   * - リンク媒体(X/はてブ): アプリは何も発行しない。開くべきURLを返し、renderer が開く
   *   (投稿/追加ボタンは人間が押す。規約=大原則)
   */
  async bulkRespond(batchId: string, itemIds: string[], approved: boolean): Promise<BulkRespondResult> {
    if (!this.ensureInitialized() || this.thread === null || this.gate === null || this.drafts === null) {
      return { ok: false, detail: '未初期化', results: [] };
    }
    const batch = this.thread.getBatch(batchId);
    if (batch === null) return { ok: false, detail: 'バッチが見つからない', results: [] };
    const selected = batch.items.filter((i) => itemIds.includes(i.id) && i.action !== undefined);
    if (selected.length === 0) return { ok: false, detail: '対象項目が無い', results: [] };

    // M43-2: 既に出した下書きは二度出さない。実際に同じZenn記事が2回コミットされた
    // (同じ下書きが別のバッチ項目として残っていて、二度承認された)
    const already = selected.filter((i) => this.draftAlreadyPosted(i.action!.params));
    for (const i of already) this.thread.respondBatchItem(batchId, i.id, true);
    const alreadyResults: BulkItemResult[] = already.map((i) => ({
      itemId: i.id,
      target: i.action!.target,
      ok: false,
      detail: '投稿済み(重複回避)',
    }));
    const items = selected.filter((i) => !already.includes(i));
    if (items.length === 0) {
      return { ok: true, detail: `${already.length}件はすでに投稿済み(重複を回避した)`, results: alreadyResults };
    }

    const keys = new Set(items.map((i) => bulkGroupKey(i.action!.adapterId, i.action!.actionName)));
    if (keys.size !== 1) {
      // 媒体・アクションが混在した一括は禁止(承認ダイアログの「何を・どこへ」が濁るため)
      return { ok: false, detail: '媒体×アクションが異なる項目は一括できない', results: [] };
    }
    const { adapterId, actionName } = items[0]!.action!;

    if (!approved) {
      for (const i of items) this.thread.respondBatchItem(batchId, i.id, false);
      return {
        ok: true,
        detail: `${items.length}件を却下した`,
        results: items.map((i) => ({ itemId: i.id, target: i.action!.target, ok: false, detail: '却下' })),
      };
    }

    this.deps.audit({
      kind: 'operations-execute',
      adapterId: `god:kamuhakari`,
      action: `batch-bulk:${adapterId}:${actionName}`,
      target: `${items.length}件`,
      approved: true,
      detail: '一括承認',
    });

    // リンク媒体: アプリは発行しない。URLを返して renderer に開かせる
    if (isLinkOnlyAdapter(adapterId)) {
      const links: { itemId: string; label: string; url: string }[] = [];
      const results: BulkItemResult[] = [];
      for (const i of items) {
        // M43-1: 古いバッチには {URL} 未解決のリンクが残っている(%7BURL%7D)。開かせない
        const blocked = this.unresolvedPlaceholderIn(i.action!.preview, i.action!.params);
        if (blocked !== null) {
          results.push({ itemId: i.id, target: i.action!.target, ok: false, detail: blocked });
          continue;
        }
        this.thread.respondBatchItem(batchId, i.id, true);
        links.push({ itemId: i.id, label: i.action!.target, url: String(i.action!.params['url'] ?? '') });
        results.push({ itemId: i.id, target: i.action!.target, ok: true, detail: 'リンクを開く' });
        // M44: リンクを渡した時点で「投稿済み」にする(残り続けると二重送信の元になる)。
        // Xは最後のPostが人間なので、実際に投稿しなかった場合はUIの「未投稿に戻す」で取り消す
        const draftId = i.action!.params['draftId'];
        if (typeof draftId === 'string' && marksDraftPosted(adapterId)) {
          this.drafts.update(draftId, { status: 'posted', media: mediaOf(adapterId) });
        }
      }
      const okCount = results.filter((r) => r.ok).length;
      return {
        ok: okCount > 0,
        detail: `${results.length}件中${okCount}件の投稿画面を開く(投稿ボタンはあなたが押す)`,
        results: [...results, ...alreadyResults],
        links: links.filter((l) => l.url !== ''),
      };
    }

    // Zenn記事は本文が未生成なので、承認ダイアログに出す前に本文を起こす(全文プレビューのため)
    const prepared: { id: string; target: string; preview: string; params: Record<string, unknown>; draftId?: string }[] = [];
    for (const i of items) {
      const a = i.action!;
      if (adapterId === 'zenn-repo' && typeof a.params['draftId'] === 'string') {
        const built = await this.buildZennArticle(String(a.params['draftId']));
        if (built === null) {
          prepared.push({ id: i.id, target: a.target, preview: a.preview, params: a.params });
          continue;
        }
        prepared.push({
          id: i.id,
          target: `zenn-content/articles/${built.slug}.md(published: false)`,
          preview: built.markdown,
          params: { slug: built.slug, markdown: built.markdown },
          draftId: String(a.params['draftId']),
        });
        continue;
      }
      prepared.push({
        id: i.id,
        target: a.target,
        preview: a.preview,
        params: a.params,
        ...(typeof a.params['draftId'] === 'string' ? { draftId: String(a.params['draftId']) } : {}),
      });
    }

    const { approved: gateOk, results } = await this.gate.requestExecuteMany(
      adapterId,
      actionName,
      prepared.map(({ id, target, preview, params }) => ({ id, target, preview, params })),
    );

    const out: BulkItemResult[] = results.map((r) => ({
      itemId: r.id,
      target: r.target,
      ok: r.ok,
      detail: r.detail,
    }));
    for (const r of out) {
      this.thread.respondBatchItem(batchId, r.itemId, gateOk && r.ok);
      // 発信ドラフト由来なら、実際に出せたものだけ「投稿済み」にする(効果測定の起点)
      const src = prepared.find((p) => p.id === r.itemId);
      if (gateOk && r.ok && src?.draftId !== undefined) {
        this.drafts.update(src.draftId, { status: 'posted', media: mediaOf(adapterId) });
        // M45: Zennは承認直前に本文(article-body)を起こす。その本文の下書きも投稿済みにする
        // (残っていると「これ出したっけ?」が再発し、二重コミットの元になる)
        const markdown = src.params['markdown'];
        if (typeof markdown === 'string') {
          const body = this.drafts.list().find((d) => d.kind === 'article-body' && d.body === markdown);
          if (body !== undefined) this.drafts.update(body.id, { status: 'posted', media: mediaOf(adapterId) });
        }
      }
    }
    const okCount = out.filter((r) => r.ok).length;
    return {
      ok: gateOk && okCount > 0,
      detail: gateOk
        ? `${out.length}件中${okCount}件成功${already.length > 0 ? `(${already.length}件は投稿済みのため実行せず)` : ''}`
        : '承認されなかったため実行していない',
      results: [...out, ...alreadyResults],
    };
  }

  /**
   * M43-2: 提案が指す下書きが既に投稿済みか。同じ下書きが複数のバッチに残ることがあり、
   * 二度承認すると同じ記事が2回コミットされる(実際に起きた)
   */
  private draftAlreadyPosted(params: Record<string, unknown>): boolean {
    const draftId = params['draftId'];
    if (typeof draftId !== 'string' || this.drafts === null) return false;
    return this.drafts.list().find((d) => d.id === draftId)?.status === 'posted';
  }

  /** M39: 記事アウトライン → 本文(frontmatter込み)。一括承認の全文プレビュー用にも使う */
  private async buildZennArticle(draftId: string): Promise<{ slug: string; markdown: string } | null> {
    if (this.drafts === null) return null;
    const draft = this.drafts.list().find((d) => d.id === draftId);
    if (draft === undefined || draft.kind !== 'article-outline') return null;
    const sources = (await this.deps.readHighlightSources?.()) ?? { progressExcerpt: '', recentCommits: '' };
    const body = await completeText(
      this.llm('planner'),
      'あなたは技術記事のライター。事実だけを書く。',
      buildArticleOutlinePrompt({
        title: draft.title,
        outline: draft.body,
        progressExcerpt: sources.progressExcerpt,
        project: this.project(),
      }),
    );
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
    // M41-3: slugのフォールバック接頭辞もプロジェクト名から(他人のプロジェクトが ama-teras-… にならない)
    const slug = articleSlug(draft.title, stamp, this.project().name);
    const markdown = buildArticleMarkdown(
      { title: draft.title, emoji: '⛩️', type: 'tech', topics: this.opsConfig().zennTopics ?? ['ai'] },
      body,
    );
    // 承認可否にかかわらず本文の下書きは残す(コピーして手で使える)
    this.drafts.add([
      { kind: 'article-body', title: `Zenn記事: ${draft.title}(${slug})`, body: markdown, media: 'zenn' },
    ]);
    return { slug, markdown };
  }

  /** 承認バッチ項目への応答。param-approval の承認は即適用(人間承認済みのため) */
  async batchRespond(batchId: string, itemId: string, approved: boolean): Promise<{ ok: boolean; detail: string }> {
    if (!this.ensureInitialized() || this.thread === null || this.scheduler === null) {
      return { ok: false, detail: '未初期化' };
    }
    const batch = this.thread.respondBatchItem(batchId, itemId, approved);
    const item = batch?.items.find((i) => i.id === itemId);
    if (!batch || !item) return { ok: false, detail: '項目が見つからない' };
    this.deps.audit({
      kind: 'operations-execute',
      adapterId: 'god:kamuhakari',
      action: `batch:${item.kind}`,
      target: item.title,
      approved,
      detail: approved ? '承認' : '却下',
    });
    if (!approved) return { ok: true, detail: '却下した' };
    if (item.kind === 'param-approval' && item.change !== undefined) {
      // 人間承認済みの変更を適用(予算引き上げ・判定プロンプト等)
      if (item.change.kind === 'budget-increase') {
        const value = typeof item.change.value === 'number' ? item.change.value : Number.NaN;
        if (!Number.isFinite(value) || value < 0) return { ok: false, detail: '不正な予算値' };
        // 人間承認済み=ユーザー設定と同格(byUser)
        this.scheduler.update(this.jobIdForGod(item.change.godId), { dailyTokenBudget: value }, { byUser: true });
        return { ok: true, detail: `予算を${value}tokへ引き上げた(人間承認済み)` };
      }
      return { ok: true, detail: `承認を記録した(${item.change.kind} の適用はv1未対応=次版で実装)` };
    }
    // M35-4: 実行内容つきのexec-action(候補フォロー等)は岩戸ゲートへ
    // (バッチ承認=意図の確認、岩戸=発信内容の最終確認。二重確認は仕様)
    if (item.kind === 'exec-action' && item.action !== undefined) {
      const a = item.action;
      // M43-2: 同じ下書きを二度出さない(古いバッチに残った項目の再承認)
      if (this.draftAlreadyPosted(a.params)) {
        return { ok: false, detail: 'この下書きはすでに投稿済み(重複を回避した)' };
      }
      return await this.execute(a.adapterId, a.actionName, a.target, a.preview, a.params);
    }
    // M33-6: 能力ギャップの3分岐
    if (item.kind === 'capability-gap' && item.gap !== undefined) {
      if (item.gap.branch === 'new-god') {
        // M42-3: レジストリに既存の神がいれば、LLMの下書きではなく **その定義** を迎える
        // (いずれにせよ岩戸ゲートで定義JSON全文の最終確認を通る)
        if (item.gap.godRegistry !== undefined) {
          const r = await this.installGodFromRegistry(item.gap.godRegistry.key);
          if (r.ok) return r;
          // レジストリ不調で神議を止めない: 下書きがあれば従来経路へフォールバック
          if (item.gap.godDraft === undefined) return r;
          this.thread?.post({
            role: 'system',
            kind: 'notice',
            body: `⛩ レジストリからの取得に失敗(${r.detail})。神議の下書き定義で続行する`,
          });
        }
        if (item.gap.godDraft !== undefined) {
          // 新神の有効化は、さらに岩戸ゲート(定義JSON全文の最終確認ダイアログ)を通る
          // =無承認の自動有効化は構造的に不可能(gods.test.ts で固定)
          return await this.requestGodDefinitionApply(item.gap.godDraft);
        }
        return { ok: false, detail: '神の定義が無い(下書きもレジストリ候補も見つからない)' };
      }
      if (item.gap.branch === 'evolve') {
        // M42-2: レジストリに既存があれば、ゼロから作らずに取り込む(検証ゲートは同じ)
        if (item.gap.registry !== undefined && this.deps.importRegistryPlugin !== undefined) {
          const key = item.gap.registry.key;
          const r = await this.deps.importRegistryPlugin(key).catch((err: unknown) => ({
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          }));
          if (r.ok) {
            const jobId = 'jobId' in r ? r.jobId : undefined;
            this.inbox?.post({
              kind: 'evolution',
              godId: 'kamuhakari',
              title: `レジストリから「${key}」を取り込み中(進化ジョブ #${jobId ?? '?'})`,
              payload: { jobId: jobId ?? 0 },
            });
            this.thread?.post({
              role: 'system',
              kind: 'notice',
              body: `📦 レジストリの既存ツール「${key}」を取り込む(${r.message})。昇格承認は進化タブで`,
            });
            return { ok: true, detail: `レジストリから取り込み: ${r.message}` };
          }
          // 取り込み失敗はレジストリの不調でしかない → 従来どおり生成へフォールバック
          this.thread?.post({
            role: 'system',
            kind: 'notice',
            body: `📦 レジストリからの取り込みに失敗(${r.message})。新規生成の起票へ切り替える`,
          });
        }
        // M38-2: 承認 → 進化ジョブとして自動起票(従来は「通常チャットで起票して」の手渡しだった)。
        // 起票の引き金は人間の承認バッチのみ。生成物の昇格は進化サブシステムの承認制のまま
        if (this.deps.enqueueEvolution === undefined) {
          return { ok: true, detail: '起票案を承認した(進化サブシステム未接続。通常チャットで request_capability として起票してください)' };
        }
        try {
          const jobId = await this.deps.enqueueEvolution(
            `[神議] ${item.title}`,
            item.detail,
          );
          this.inbox?.post({
            kind: 'evolution',
            godId: 'kamuhakari',
            title: `進化ジョブ #${jobId} を起票した: ${item.title}`,
            payload: { jobId },
          });
          this.thread?.post({
            role: 'system',
            kind: 'notice',
            body: `🧬 承認により進化ジョブ #${jobId} を起票した(「${item.title}」)。進捗と昇格承認は進化タブで`,
          });
          return { ok: true, detail: `進化ジョブ #${jobId} を起票した(進捗・昇格承認は進化タブ)` };
        } catch (err) {
          return { ok: false, detail: `進化ジョブの起票に失敗: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      return { ok: true, detail: '単発カバーを承認した。提案の下書きを通常チャットで実行してください' };
    }
    return { ok: true, detail: '承認を記録した(実行系は岩戸ゲート経由で別途実行)' };
  }

  async status(): Promise<OperationsStatus> {
    if (!this.ensureInitialized() || this.gate === null) {
      return { enabled: false, ghDetected: false, ghPath: null, adapters: [], repos: [] };
    }
    return {
      enabled: true,
      ghDetected: this.github !== null,
      ghPath: this.ghPath,
      adapters: await this.gate.status(),
      repos: [...this.opsConfig().repos],
    };
  }

  private llm(band: 'planner' | 'reviewer'): LLMProvider {
    const provider = this.deps.bandProvider(band);
    if (typeof provider === 'string') throw new Error(provider);
    return provider;
  }

  // ---- OMOI-kami ----

  async collectSnapshot(): Promise<MetricsSnapshot | null> {
    if (!this.ensureInitialized() || this.omoi === null) return null;
    return this.omoi.collectSnapshot(this.opsConfig(), this.deps.getConfig().registryUrl);
  }

  history(limit = 30): MetricsSnapshot[] {
    if (!this.ensureInitialized() || this.omoi === null) return [];
    return this.omoi.history(limit);
  }

  async weeklyReport(): Promise<OperationsDraft | null> {
    if (!this.ensureInitialized() || this.omoi === null || this.drafts === null) return null;
    const snapshots = this.omoi.history(14);
    const posted = this.drafts.list().filter((d) => d.status === 'posted');
    const prompt = this.omoi.buildWeeklyReportPrompt(snapshots, posted);
    const text = await completeText(this.llm('planner'), 'あなたはOSS運営の参謀。', prompt);
    const [draft] = this.drafts.add([{ kind: 'weekly-report', title: `週報 ${new Date().toISOString().slice(0, 10)}`, body: text }]);
    return draft ?? null;
  }

  // ---- AMENO-uzume ----

  async generateDrafts(): Promise<OperationsDraft[]> {
    if (!this.ensureInitialized() || this.drafts === null || this.omoi === null) return [];
    const sources = (await this.deps.readHighlightSources?.()) ?? {
      progressExcerpt: '',
      recentCommits: '',
    };
    const { current, previous } = this.omoi.latestPair();
    const prompt = buildHighlightPrompt({ ...sources, current, previous, project: this.project() });
    const text = await completeText(this.llm('planner'), 'あなたはOSSの広報担当。', prompt);
    const parsed = parseDrafts(text);
    if (parsed.length === 0) return [];
    return this.drafts.add(parsed);
  }

  listDrafts(): OperationsDraft[] {
    if (!this.ensureInitialized() || this.drafts === null) return [];
    // M43-1: UI(コピー・リンク)に渡す時点で {URL} を解決しておく。
    // ここを通らない経路が無いよう、下書きの読み出しは必ずこのメソッド経由にすること
    const url = this.projectUrl();
    return this.drafts.list().map((d) => ({ ...d, body: resolvePostText(d.body, url) }));
  }

  /** M43-1: {URL} の解決先。設定のプロジェクトURL → 観測対象リポジトリ → 空(=プレースホルダごと落とす) */
  private projectUrl(): string {
    const cfg = this.opsConfig();
    const explicit = (cfg.projectUrl ?? '').trim();
    return explicit !== '' ? explicit : repoUrl(cfg.repos[0]);
  }

  updateDraft(
    id: string,
    patch: Partial<Pick<OperationsDraft, 'status' | 'body' | 'title' | 'media'>>,
  ): OperationsDraft | null {
    if (!this.ensureInitialized() || this.drafts === null) return null;
    return this.drafts.update(id, patch);
  }

  // ---- M38-3: 発信の効果測定(投稿 → 前後メトリクス差分)----

  /**
   * 投稿済みドラフト × メトリクス時系列の前後差分。
   * 神議が能力ギャップ(evolve)として要求した「投稿URL→前後メトリクス差分の自動記録」の実体。
   */
  impacts(windowHours = 24): ImpactEntry[] {
    if (!this.ensureInitialized() || this.drafts === null || this.omoi === null) return [];
    const posted = this.drafts.list().filter((d) => d.status === 'posted');
    return computeImpacts(posted, this.omoi.history(200), new Date(), windowHours);
  }

  /** 計測窓が閉じた投稿の効果を、1投稿につき1回だけ受け箱へ投函する。戻り値=今回報告した件数 */
  private reportImpacts(godId: string): number {
    if (this.inbox === null) return 0;
    const params = this.loadParams();
    const already = new Set(params.impactReported ?? []);
    const fresh = this.impacts().filter((e) => e.measurable && !already.has(e.draftId));
    for (const entry of fresh) {
      this.inbox.post({
        kind: 'metrics',
        godId,
        title: `効果測定: ${summarize(entry)}`,
        // 因果ではなく相関(同時期の他要因は排除できない)。判断材料としてのみ使う
        payload: {
          draftId: entry.draftId,
          url: entry.url,
          media: entry.media,
          postedAt: entry.postedAt,
          delta: entry.delta,
        },
      });
      already.add(entry.draftId);
    }
    if (fresh.length > 0) this.saveParams({ ...params, impactReported: [...already] });
    return fresh.length;
  }

  // ---- M37: 下書きの行き先(種類ごとに固定。すべて岩戸ゲート経由)----

  /**
   * リリースノート下書き → GitHub Release(下書き)。
   * 承認ダイアログに repo/tag/全文を出し、承認後に gh release create --draft(既存タグなら本文更新)。
   */
  /**
   * M46: リリースのバージョン管理を人間の記憶から外す。
   * GitHubの最新リリースを見て、patch/minor/major の次バージョンを機械的に出す。
   * appVersion(package.json)と食い違っていたら知らせる — 食い違ったまま出すと、
   * 利用者の更新バナー(M42-1)が「新しい版がある」と言い続ける/言わなくなる
   */
  async releaseInfo(repo: string): Promise<{
    latestTag: string | null;
    appVersion: string;
    suggestions: { patch: string | null; minor: string | null; major: string | null };
    mismatch: boolean;
  }> {
    const appVersion = this.deps.appVersion ?? '';
    const empty = {
      latestTag: null,
      appVersion,
      suggestions: { patch: null, minor: null, major: null },
      mismatch: false,
    };
    if (!this.ensureInitialized() || this.ghRun === null) return empty;
    // 最新リリースが無い(初回)なら latestTag は null → UIは appVersion を初期候補にする
    const out = await this.ghRun(['release', 'view', '-R', repo, '--json', 'tagName']).catch(() => '');
    let latestTag: string | null = null;
    try {
      const parsed: unknown = JSON.parse(out);
      const t = (parsed as Record<string, unknown> | null)?.['tagName'];
      if (typeof t === 'string' && t !== '') latestTag = t;
    } catch {
      /* リリース無し・gh不在は latestTag=null(手入力へ落とす) */
    }
    return {
      latestTag,
      appVersion,
      suggestions: {
        patch: nextVersion(latestTag, 'patch'),
        minor: nextVersion(latestTag, 'minor'),
        major: nextVersion(latestTag, 'major'),
      },
      // 直近リリースとアプリの版が食い違っている = package.json の更新を忘れている合図
      mismatch: latestTag !== null && appVersion !== '' && !sameVersion(latestTag, appVersion),
    };
  }

  /**
   * M47: リリースの前に package.json の version を上げる(コミット・push まで)。
   * 岩戸ゲートの承認を通る。ここを忘れると更新確認(M42-1)が壊れるので、
   * requestRelease から自動で呼ばれる(UIのチェックを外せばスキップできる)
   */
  async bumpPackageVersion(tag: string): Promise<{ ok: boolean; detail: string }> {
    if (!this.ensureInitialized() || this.gate === null) {
      return { ok: false, detail: 'オーナーモードがOFF(運営機能は無効)' };
    }
    const workspace = this.deps.getConfig().workspace;
    if (workspace === undefined || workspace === '') {
      return { ok: false, detail: 'workspace が未設定(package.json の場所が分からない)' };
    }
    const to = versionFromTag(tag);
    const from = readPackageVersion(workspace);
    if (from === null) return { ok: false, detail: 'package.json の version を読めない' };
    if (from === to) return { ok: true, detail: `package.json はすでに ${to}` };
    return this.gate.requestExecute(
      'repo-version',
      'bump',
      `${workspace}/package.json の version を ${from} → ${to} に上げてコミット・push`,
      `- ファイル: ${workspace}/package.json\n- version: "${from}" → "${to}"\n- コミット: chore: bump version to ${to}\n- push先: origin の現在のブランチ\n\n` +
        `※ ここを上げないと、利用者のアプリに更新通知が出ません(更新確認は package.json の version と最新リリースのタグを比べます)`,
      { to },
    );
  }

  async requestRelease(draftId: string, repo: string, tag: string): Promise<{ ok: boolean; detail: string }> {
    if (!this.ensureInitialized() || this.gate === null || this.drafts === null) {
      return { ok: false, detail: 'オーナーモードがOFF(運営機能は無効)' };
    }
    const draft = this.drafts.list().find((d) => d.id === draftId);
    if (draft === undefined) return { ok: false, detail: '下書きが見つからない' };
    if (draft.kind !== 'release-note') return { ok: false, detail: 'この下書きはリリースノートではない' };
    // M45: 単発経路も二度出さない(一括経路と同じガード)
    if (draft.status === 'posted') return { ok: false, detail: 'この下書きはすでに出している(重複を回避した)' };
    const cleanTag = tag.trim();
    if (!/^[\w.\-+]{1,64}$/.test(cleanTag)) return { ok: false, detail: `タグ名が不正: ${cleanTag}` };
    if (!this.opsConfig().repos.includes(repo)) {
      return { ok: false, detail: `観測対象リポジトリに無い: ${repo}` };
    }
    const result = await this.gate.requestExecute(
      'github',
      'release',
      `${repo} のリリース ${cleanTag}(下書きとして作成/更新。公開はあなたがGitHub上で行う)`,
      `# ${draft.title}\n\n${draft.body}`,
      { repo, tag: cleanTag, title: draft.title, body: draft.body },
    );
    // M45: 出せたら投稿済み(一括経路だけがやっていて、単発ボタンは残り続けていた)
    if (result.ok) this.drafts.update(draftId, { status: 'posted', media: mediaOf('github') });
    return result;
  }

  /**
   * 記事アウトライン → Zenn記事化。
   * LLMで本文を起こして下書き(article-body)として保存し、そのうえで岩戸ゲートへ。
   * 承認されれば zenn-content の articles/ に published: false でコミット・push。
   * 承認されなくても本文の下書きは残る(コピーして手で使える)。
   */
  async requestZennArticle(draftId: string): Promise<{ ok: boolean; detail: string; bodyDraftId?: string }> {
    if (!this.ensureInitialized() || this.gate === null || this.drafts === null) {
      return { ok: false, detail: 'オーナーモードがOFF(運営機能は無効)' };
    }
    const draft = this.drafts.list().find((d) => d.id === draftId);
    if (draft === undefined) return { ok: false, detail: '下書きが見つからない' };
    if (draft.kind !== 'article-outline') return { ok: false, detail: 'この下書きは記事アウトラインではない' };
    // M45: 同じ記事を二度コミットしない(実際に別slugで2回コミットされた。M43-2の単発版)
    if (draft.status === 'posted') return { ok: false, detail: 'この記事はすでにコミット済み(重複を回避した)' };
    if ((this.opsConfig().zennRepoDir ?? '') === '') {
      return { ok: false, detail: 'zenn-contentのパスが未設定(設定→接続→オーナーモード)' };
    }

    const built = await this.buildZennArticle(draftId);
    if (built === null) return { ok: false, detail: '本文の生成に失敗' };
    const saved = this.drafts.list().find((d) => d.kind === 'article-body' && d.body === built.markdown);
    const result = await this.gate.requestExecute(
      'zenn-repo',
      'commit-article',
      `zenn-content/articles/${built.slug}.md(published: false。公開はZennの記事設定であなたが行う)`,
      built.markdown,
      { slug: built.slug, markdown: built.markdown },
    );
    // M45: コミットできたら、アウトラインと本文の両方を投稿済みにする
    // (本文の下書きが残っていると「これ出したっけ?」が再発する)
    if (result.ok) {
      this.drafts.update(draftId, { status: 'posted', media: mediaOf('zenn-repo') });
      if (saved !== undefined) this.drafts.update(saved.id, { status: 'posted', media: mediaOf('zenn-repo') });
    }
    return { ...result, ...(saved !== undefined ? { bodyDraftId: saved.id } : {}) };
  }

  strategyBoard(): MediaStrategyEntry[] {
    if (!this.ensureInitialized() || this.omoi === null) return [];
    return strategyBoard(this.omoi.latestPair().current);
  }

  /** 仲間発見: 検索URL(X=人間が開く)+Bluesky公開検索+HN検索(M33-7)の結果 */
  async discoverySearch(
    keywords: string[],
  ): Promise<{ x: XSearchSuggestion[]; bluesky: BlueskyPost[]; hn: HnStory[] }> {
    if (!this.ensureInitialized()) return { x: [], bluesky: [], hn: [] };
    const x = buildXSearchSuggestions(keywords, this.opsConfig().projectName);
    const query = keywords.filter((k) => k.trim() !== '').join(' ');
    const bluesky = query === '' ? [] : await this.bluesky.searchPosts(query, 10);
    const hn = query === '' ? [] : await this.hn.search(query, 5);
    return { x, bluesky, hn };
  }

  /** 貼り付け解析 → 候補カード保存 */
  async analyzeCandidate(pastedText: string, source: string): Promise<CommunityCandidate | null> {
    if (!this.ensureInitialized() || this.candidates === null) return null;
    const text = await completeText(this.llm('planner'), 'あなたはコミュニティ担当。', buildCandidatePrompt(pastedText));
    const parsed = parseCandidate(text, source, pastedText);
    if (parsed === null) return null;
    return this.candidates.add(parsed);
  }

  listCandidates(): CommunityCandidate[] {
    if (!this.ensureInitialized() || this.candidates === null) return [];
    return this.candidates.list();
  }

  resolveCandidate(id: string, status: 'kept' | 'discarded'): CommunityCandidate | null {
    if (!this.ensureInitialized() || this.candidates === null) return null;
    return this.candidates.resolve(id, status);
  }

  // ---- TEDIKA-rao ----

  async triage(): Promise<TriageCard[]> {
    if (!this.ensureInitialized() || this.github === null) return [];
    const cfg = this.opsConfig();
    const cards: TriageCard[] = [];
    for (const repo of cfg.repos) {
      // レジストリリポジトリのPRはCI(check-runs)を統合表示
      const withCi = repo.includes('registry');
      const llm = (prompt: string): Promise<string> =>
        completeText(this.llm('reviewer'), 'あなたはOSSの門番レビュアー。', prompt);
      cards.push(...(await triageRepo(repo, this.github, llm, { withCi, project: this.project() })));
    }
    this.triageCache = cards;
    return cards;
  }

  listTriage(): TriageCard[] {
    return this.triageCache;
  }

  // ---- 岩戸ゲート(execute) ----

  async execute(
    adapterId: string,
    action: string,
    target: string,
    preview: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; detail: string }> {
    if (!this.ensureInitialized() || this.gate === null) {
      return { ok: false, detail: 'オーナーモードがOFF(運営機能は無効)' };
    }
    const unresolved = this.unresolvedPlaceholderIn(preview, params);
    if (unresolved !== null) return { ok: false, detail: unresolved };
    return this.gate.requestExecute(adapterId, action, target, preview, params);
  }

  /**
   * M43-1: 最後の砦。テンプレートのプレースホルダ(`{URL}` 等)が残ったまま外に出さない。
   * 実際に X と Bluesky へ `{URL}` の文字列が投稿された事故を受けて追加した
   */
  private unresolvedPlaceholderIn(preview: string, params: Record<string, unknown>): string | null {
    const texts = [preview, ...Object.values(params).filter((v): v is string => typeof v === 'string')];
    // URLはエンコード済み(%7BURL%7D)の形でも入るため、デコードして見る
    for (const t of texts) {
      let decoded = t;
      try {
        decoded = decodeURIComponent(t);
      } catch {
        /* デコードできない文字列はそのまま見る */
      }
      if (hasUnresolvedPlaceholder(decoded)) {
        return '未解決のプレースホルダ({URL} 等)が残っているため実行しない。設定の「プロジェクトURL」か観測対象リポジトリを設定するか、下書きを編集してください';
      }
    }
    return null;
  }
}
