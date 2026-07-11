import { join } from 'node:path';
import type {
  AdapterStatusInfo,
  AppConfig,
  CommunityCandidate,
  IwatoRequestPayload,
  MediaStrategyEntry,
  MetricsSnapshot,
  OperationsConfig,
  OperationsDraft,
  TriageCard,
} from '../../shared/types';
import type { LLMProvider } from '../providers/types';
import { createBlueskyAdapter, BlueskyReader, type BlueskyPost } from './adapters/bluesky';
import { createGithubAdapter, defaultGhRunner, detectGhPath, GithubReader, type GhRunner } from './adapters/github';
import { createXAdapter, buildXSearchSuggestions, type XSearchSuggestion } from './adapters/x';
import { createZennAdapter, ZennReader, type FetchLike } from './adapters/zenn';
import {
  buildCandidatePrompt,
  buildHighlightPrompt,
  CandidateStore,
  DraftStore,
  parseCandidate,
  parseDrafts,
  strategyBoard,
} from './amenoUzume';
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
  /** テスト用注入 */
  ghRunner?: GhRunner;
  fetchImpl?: FetchLike;
  /** workspace のPROGRESS.md/git logを読む(発信ドラフトの素材) */
  readHighlightSources?: () => Promise<{ progressExcerpt: string; recentCommits: string }>;
}

export interface OperationsStatus {
  enabled: boolean;
  ghDetected: boolean;
  ghPath: string | null;
  adapters: AdapterStatusInfo[];
}

/** M33: 神ごとのパラメータ(キーワード・巡回済み記録・Issue差分基準)。userData/operations/god-params.json */
interface GodParams {
  keywords: string[];
  /** Bluesky巡回の重複排除: 評価済み投稿uri・評価済みhandle */
  seenUris: string[];
  seenHandles: string[];
  /** TEDIKA-rao差分チェックの既知Issue/PR番号(repo別) */
  knownIssues: Record<string, number[]>;
}

const DEFAULT_GOD_PARAMS: GodParams = {
  keywords: ['AIエージェント 自作', 'self-evolving agent'],
  seenUris: [],
  seenHandles: [],
  knownIssues: {},
};

/** 既定の神々の時計(NIGHT_TASKS7 T3/T4。ユーザーは運営タブから変更可) */
const DEFAULT_JOBS: GodClockJob[] = [
  { id: 'omoi-kami', godId: 'omoi-kami', intervalMin: 360, enabled: true, dailyTokenBudget: 0, spentToday: 0 },
  { id: 'uzume-patrol', godId: 'uzume-patrol', intervalMin: 60, enabled: true, dailyTokenBudget: 30_000, spentToday: 0 },
  { id: 'uzume-drafts', godId: 'uzume-drafts', intervalMin: 1440, enabled: true, dailyTokenBudget: 20_000, spentToday: 0 },
  { id: 'tedika-rao', godId: 'tedika-rao', intervalMin: 60, enabled: true, dailyTokenBudget: 30_000, spentToday: 0 },
  { id: 'kamuhakari', godId: 'kamuhakari', intervalMin: 720, dailyTimes: ['09:00', '21:00'], enabled: true, dailyTokenBudget: 60_000, spentToday: 0 },
];

export class OperationsManager {
  private gate: IwatoGate | null = null;
  private github: GithubReader | null = null;
  private zenn: ZennReader;
  private bluesky: BlueskyReader;
  private omoi: OmoiKami | null = null;
  private drafts: DraftStore | null = null;
  private candidates: CandidateStore | null = null;
  private ghPath: string | null = null;
  private triageCache: TriageCard[] = [];
  private inbox: Inbox | null = null;
  private thread: OpsThread | null = null;
  private scheduler: GodScheduler | null = null;

  constructor(private readonly deps: OperationsManagerDeps) {
    this.zenn = new ZennReader(deps.fetchImpl);
    this.bluesky = new BlueskyReader(deps.fetchImpl);
  }

  private opsConfig(): OperationsConfig {
    return this.deps.getConfig().operations ?? { enabled: false, repos: [], zennSlugs: [] };
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

    const gate = new IwatoGate(this.deps.approvalPrompt, this.deps.audit);
    if (run !== null) gate.register(createGithubAdapter(run, () => true));
    gate.register(createZennAdapter());
    gate.register(createXAdapter());
    gate.register(createBlueskyAdapter());
    this.gate = gate;

    this.omoi = new OmoiKami(this.dir, {
      github: this.github,
      zenn: this.zenn,
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
    this.scheduler.ensureJobs(DEFAULT_JOBS);
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
  }

  // ---- M33: 神パラメータ(キーワード・重複排除・差分基準) ----

  private get paramsPath(): string {
    return join(this.dir, 'god-params.json');
  }

  private loadParams(): GodParams {
    try {
      const parsed = JSON.parse(readFileSync(this.paramsPath, 'utf8')) as Partial<GodParams>;
      return { ...DEFAULT_GOD_PARAMS, ...parsed };
    } catch {
      return { ...DEFAULT_GOD_PARAMS };
    }
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

  private cheapLLM(): ReturnType<OperationsManagerDeps['bandProvider']> {
    // 神エージェントは安い帯。worker帯が未設定でも service 側が単一モデルへフォールバックする
    return this.deps.bandProvider('worker');
  }

  private async runGod(godId: string): Promise<{ ok: boolean; detail: string; tokensUsed: number }> {
    if (this.inbox === null) return { ok: false, detail: '未初期化', tokensUsed: 0 };
    try {
      if (godId === 'omoi-kami') {
        const snap = await this.collectSnapshot();
        if (snap === null) return { ok: false, detail: '収集失敗', tokensUsed: 0 };
        const stars = Object.values(snap.github).reduce((a, m) => a + m.stars, 0);
        const liked = Object.values(snap.zenn).reduce((a, m) => a + m.liked, 0);
        this.inbox.post({
          kind: 'metrics',
          godId,
          title: `観測: ★${stars} / Zenn♥${liked}`,
          payload: { ts: snap.ts },
        });
        return { ok: true, detail: 'スナップショット投函', tokensUsed: 0 };
      }
      if (godId === 'uzume-patrol') return await this.runUzumePatrol();
      if (godId === 'uzume-drafts') return await this.runUzumeDrafts();
      if (godId === 'tedika-rao') return await this.runTedikaDiff();
      if (godId === 'kamuhakari') {
        const result = await this.runKamuhakari();
        return { ok: true, detail: `神議完了(適用${result.appliedChanges.length}/バッチ${result.batch ? 1 : 0})`, tokensUsed: result.tokensUsed };
      }
      return { ok: false, detail: `未知の神: ${godId}`, tokensUsed: 0 };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err), tokensUsed: 0 };
    }
  }

  /** AMENO-uzume 巡回(1時間ごと): Bluesky検索→未評価のみ安い帯で目利き→候補+受け箱 */
  private async runUzumePatrol(): Promise<{ ok: boolean; detail: string; tokensUsed: number }> {
    if (this.candidates === null || this.inbox === null) return { ok: false, detail: '未初期化', tokensUsed: 0 };
    const params = this.loadParams();
    const provider = this.cheapLLM();
    if (typeof provider === 'string') return { ok: false, detail: provider, tokensUsed: 0 };

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
          buildCandidatePrompt(pasted),
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
      buildHighlightPrompt({ ...sources, current, previous }),
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
    const provider = this.deps.bandProvider('planner');
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

    const batch = buildApprovalBatch(parsed.analysis, approvalChanges, parsed.proposals);
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

  // ---- M33: UI用アクセサ ----

  clocks(): GodClockJob[] {
    if (!this.ensureInitialized() || this.scheduler === null) return [];
    return this.scheduler.list();
  }

  updateClock(id: string, patch: { intervalMin?: number; enabled?: boolean; dailyTokenBudget?: number }): GodClockJob | null {
    if (!this.ensureInitialized() || this.scheduler === null) return null;
    return this.scheduler.update(id, patch);
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
    const provider = this.deps.bandProvider('planner');
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

  /** 承認バッチ項目への応答。param-approval の承認は即適用(人間承認済みのため) */
  batchRespond(batchId: string, itemId: string, approved: boolean): { ok: boolean; detail: string } {
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
        this.scheduler.update(this.jobIdForGod(item.change.godId), { dailyTokenBudget: value });
        return { ok: true, detail: `予算を${value}tokへ引き上げた(人間承認済み)` };
      }
      return { ok: true, detail: `承認を記録した(${item.change.kind} の適用はv1未対応=次版で実装)` };
    }
    return { ok: true, detail: '承認を記録した(実行系は岩戸ゲート経由で別途実行)' };
  }

  async status(): Promise<OperationsStatus> {
    if (!this.ensureInitialized() || this.gate === null) {
      return { enabled: false, ghDetected: false, ghPath: null, adapters: [] };
    }
    return {
      enabled: true,
      ghDetected: this.github !== null,
      ghPath: this.ghPath,
      adapters: await this.gate.status(),
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
    const prompt = buildHighlightPrompt({ ...sources, current, previous });
    const text = await completeText(this.llm('planner'), 'あなたはOSSの広報担当。', prompt);
    const parsed = parseDrafts(text);
    if (parsed.length === 0) return [];
    return this.drafts.add(parsed);
  }

  listDrafts(): OperationsDraft[] {
    if (!this.ensureInitialized() || this.drafts === null) return [];
    return this.drafts.list();
  }

  updateDraft(
    id: string,
    patch: Partial<Pick<OperationsDraft, 'status' | 'body' | 'title' | 'media'>>,
  ): OperationsDraft | null {
    if (!this.ensureInitialized() || this.drafts === null) return null;
    return this.drafts.update(id, patch);
  }

  strategyBoard(): MediaStrategyEntry[] {
    if (!this.ensureInitialized() || this.omoi === null) return [];
    return strategyBoard(this.omoi.latestPair().current);
  }

  /** 仲間発見: 検索URL(X=人間が開く)+Bluesky公開検索の結果 */
  async discoverySearch(keywords: string[]): Promise<{ x: XSearchSuggestion[]; bluesky: BlueskyPost[] }> {
    if (!this.ensureInitialized()) return { x: [], bluesky: [] };
    const x = buildXSearchSuggestions(keywords);
    const query = keywords.filter((k) => k.trim() !== '').join(' ');
    const bluesky = query === '' ? [] : await this.bluesky.searchPosts(query, 10);
    return { x, bluesky };
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
      cards.push(...(await triageRepo(repo, this.github, llm, { withCi })));
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
    return this.gate.requestExecute(adapterId, action, target, preview, params);
  }
}
