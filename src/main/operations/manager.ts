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
import { completeText } from './llm';
import { OmoiKami } from './omoiKami';
import { IwatoGate, type IwatoAuditEvent } from './protocol';
import { triageRepo } from './tedikaRao';

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
  /** LLM帯の取得(service注入。string=キー未設定メッセージ) */
  bandProvider: (band: 'planner' | 'reviewer') => LLMProvider | string;
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
    return true;
  }

  /** 設定変更(オーナーモードOFF化)で状態を破棄 */
  reset(): void {
    this.gate = null;
    this.github = null;
    this.omoi = null;
    this.drafts = null;
    this.candidates = null;
    this.ghPath = null;
    this.triageCache = [];
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
