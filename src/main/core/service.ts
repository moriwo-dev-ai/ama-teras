import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentStatus,
  AgentStatusView,
  AppConfig,
  ApprovalDecision,
  ApprovalRequestPayload,
  ChatImageInput,
  ChatMode,
  CheckpointInfo,
  CheckpointRestoreResult,
  EvolutionEvent,
  EvolutionJobSummary,
  FilePreviewResult,
  HistoryMessageView,
  ModelPolicy,
  PluginErrorInfo,
  ProviderId,
  ReviewCardPayload,
  SessionLoadResult,
  SessionMeta,
  SubAgentUpdate,
  ToolExecResultPayload,
  ToolInfo,
} from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { compactHistory, DEFAULT_COMPACTION_THRESHOLD, estimateTokens } from '../agent/compaction';
import { runAgentLoop } from '../agent/loop';
import { contextLimitFor, DEFAULT_MODELS } from '../../shared/models';
import {
  MAX_PARALLEL_SUBAGENTS,
  runSubAgent,
  runWorkSubAgent,
  WriteLockTable,
} from '../agent/subagent';
import {
  appendLearnedMemory,
  composePlanSection,
  composeSystemPrompt,
  readProjectMemory,
  readProjectPlan,
} from '../memory';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from '../providers/anthropic';
import { DEFAULT_OPENAI_MODEL, OpenAIProvider } from '../providers/openai';
import type { ChatMessage, LLMProvider } from '../providers/types';
import { buildFixTask, runReviewCycle, runReviewer, type ReviewTarget } from '../review/gate';
import { newlyCompleted } from '../review/planDiff';
import {
  executeToolWithApproval,
  type ExecutorDeps,
  type ScopeAuditEvent,
  type ScopePolicy,
} from '../tools/executor';
import type { ToolPlugin } from '../tools/types';
import type { EventBus } from './events';
import { ProcessManager } from './processes';
import { previewFile } from './filePreview';
import { foldHistoryIfOversize, SESSION_SCHEMA_VERSION, type SessionData } from './sessions';

/**
 * M10-1: transport 非依存のコアサービス。
 * ipc.ts(デスクトップ)と remote/server.ts(スマホWeb)の両方がここへ委譲する。
 * electron を import しない(パス等は deps で注入)ため、ユニットテスト可能。
 */

/** ToolRegistry を構造的に満たす最小インターフェース */
export interface RegistryLike {
  list(): ToolPlugin[];
  get(name: string): ToolPlugin | undefined;
  reload(): Promise<void>;
  readonly errors: PluginErrorInfo[];
}

/** EvolutionManager を構造的に満たす最小インターフェース */
export interface EvolutionLike {
  list(): EvolutionJobSummary[];
  enqueue(req: { description: string; expectedIO: string }): Promise<number>;
}

/** EvolutionManager 生成時にサービス側が渡すフック(昇格承認の待ち合わせとイベント中継) */
export interface EvolutionHooks {
  requestPromotionApproval: (
    job: EvolutionJobSummary,
    diff: string,
    warnings: string[],
  ) => Promise<boolean>;
  onEvent: (e: EvolutionEvent) => void;
}

export type PromotionRequestEvent = Extract<EvolutionEvent, { kind: 'promotion_request' }>;

/** SessionStore を構造的に満たす最小インターフェース(M12-1。テストではモック可能) */
export interface SessionsLike {
  save(data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  list(): Promise<SessionMeta[]>;
  delete(id: string): Promise<void>;
  /** M15-2(任意): 検索・名前変更。未実装ストアでは機能が無効になるだけ */
  search?(query: string): Promise<SessionMeta[]>;
  rename?(id: string, title: string): Promise<boolean>;
}

/** CheckpointManager を構造的に満たす最小インターフェース(M11-3。テストではモック可能) */
export interface CheckpointsLike {
  readonly workspace: string;
  snapshot(sessionId: string, label: string): Promise<string | null>;
  list(): Promise<CheckpointInfo[]>;
  restore(sha: string): Promise<CheckpointRestoreResult>;
}

export interface AgentServiceDeps {
  bus: EventBus;
  registry: RegistryLike;
  /** set は M15.1 の sessionOpen(workspace追従)にだけ使う。未指定なら追従しない */
  config: { get(): AppConfig; set?(next: AppConfig): unknown };
  secrets: { get(provider: ProviderId): string | null };
  audit: { append(e: ScopeAuditEvent): void };
  /** config.workspace 未設定時の既定作業ディレクトリ(electron の app.getAppPath() 相当) */
  defaultWorkspace: () => string;
  /** M9 スコープ制御のハード拒否対象パス */
  denyPaths: { userDataDir: string; repoGitDir: string };
  /** EvolutionManager の生成。electron 依存の部分(repoDir 等)は呼び出し側が握る */
  createEvolution: (hooks: EvolutionHooks) => EvolutionLike;
  /** テスト用: プロバイダ生成の差し替え(未指定なら config/secrets から実プロバイダを作る) */
  providerFactory?: () => LLMProvider | string;
  /**
   * M11-3: 自動チェックポイントの生成(workspace ごと)。未指定なら機能全体が無効。
   * メインループ専用 — 進化ジョブ(AgentJobRunner)はこの service を経由しないため波及しない。
   */
  createCheckpoints?: (workspace: string) => CheckpointsLike;
  /** M12-1: セッション永続化ストア。未指定なら機能全体が無効(保存もUIも動かないだけ) */
  sessions?: SessionsLike;
  /**
   * M14-2: URLスクリーンショット(offscreen BrowserWindow)。electron 依存のため注入。
   * 未指定なら screenshot ツールは「未注入」エラーになる。進化ジョブへは渡らない
   */
  captureUrl?: (url: string, width?: number, height?: number) => Promise<{ data: string; mediaType: string }>;
  /** M16-2 テスト用: フォールバックプロバイダ生成の差し替え(未指定なら secrets から実プロバイダ) */
  fallbackProviderFactory?: (provider: ProviderId, model: string) => LLMProvider;
  /**
   * M18 テスト用: 帯プロバイダ生成の差し替え。キー有無の判定(secrets)は差し替えの
   * 前に行われる(キー未登録の警告経路もテスト可能にするため)
   */
  bandProviderFactory?: (band: ModelBandName, provider: ProviderId, model: string) => LLMProvider;
}

/** M18: モデル帯の名前 */
export type ModelBandName = 'planner' | 'worker' | 'escalation';

const SYSTEM_PROMPT = `あなたは AMA-teras — ユーザーのマシン上で動くコーディングエージェント。
与えられたツールを使ってファイルの調査・編集・コマンド実行を行い、ユーザーの指示を完遂する。

規範:
- 手を動かす前に不明点があれば read_file / list_dir / grep で自分で調べる
- 変更は最小限に。既存のコードスタイルに合わせる
- 破壊的な操作は慎重に。ツール実行はユーザー承認制の場合がある
- 複数ステップに及ぶ作業では、最初に plan ツールで計画(- [ ] 形式)を書き、
  項目が完了するたびに - [x] へ更新すること(計画は毎ターン注入され、長い作業でも失われない)
- 今後も使う知見(ビルド方法・規約・ハマりどころ)を発見したら memory ツールで短く追記すること。
  会話固有の一時的な内容は記憶に書かないこと
- 完了したら何をしたか簡潔に日本語で報告する`;

const PLAN_SUFFIX = `\n\n# プランモード\n今回は「計画のみ」を求められている。実装に入らず、
何をどの順で行うか(触るファイル・使うツール・確認事項)を簡潔な計画として提示せよ。
ツールは実行しない。ユーザーが計画を承認したら、次のメッセージで通常モードとして実行する。`;

/** M18: modelPolicy 有効時のみ system prompt に付ける分業ヒント(強制はしない) */
const POLICY_HINT = `\n\n# 分業ヒント(モデル自動切替 有効)
あなた(メイン会話)は高性能な planner 帯で動いている。実装の手数が多い工程
(複数ファイルの編集・テストの反復実行など)は dispatch_agent(mode:"work")へ委譲し、
あなたは計画・レビュー・統合・最終報告に集中すること。小さな作業は直接行ってよい。`;

/** 会話履歴を表示用に整形する(tool_result のみのメッセージは省く) */
export function toHistoryView(messages: ChatMessage[]): HistoryMessageView[] {
  const views: HistoryMessageView[] = [];
  for (const msg of messages) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text);
      else if (block.type === 'image') parts.push(`🖼 [画像: ${block.description ?? block.mediaType}]`);
      else if (block.type === 'tool_use') parts.push(`⚙ ${block.name}`);
    }
    if (parts.length > 0) views.push({ role: msg.role, text: parts.join('\n') });
  }
  return views;
}

export class AgentService {
  readonly broker: ApprovalBroker;
  /** M11-2: バックグラウンドプロセス管理(メインセッション専用。進化ジョブには注入しない) */
  readonly processes = new ProcessManager();
  private readonly evolution: EvolutionLike;
  private readonly history: ChatMessage[] = [];
  private activeRun: { sessionId: string; ac: AbortController } | null = null;
  private lastStatus: AgentStatus = 'idle';
  private readonly pendingApprovals = new Map<string, ApprovalRequestPayload>();
  private checkpointsCache: CheckpointsLike | null = null;
  private readonly pendingPromotions = new Map<number, (approved: boolean) => void>();
  private readonly pendingPromotionEvents = new Map<number, PromotionRequestEvent>();
  /** M12-1: 継続中の会話の永続化メタ(イベント用 sessionId とは別で、送信を跨いで維持される) */
  private conversation: {
    id: string;
    title: string;
    createdAt: string;
    /** M16-1: 最後にLLM呼び出しに使った provider+model(切替検知用) */
    lastLLM?: { provider: ProviderId; model: string };
  } | null = null;
  /** M12-3: 子エージェントの連番(UI表示・承認ダイアログの出所表示用) */
  private subAgentSeq = 0;
  /** M13-1: 直近APIコールの実測プロンプトトークン(compaction発火判定用) */
  private lastPromptTokens = 0;
  /** M16-2: フォールバックを使い切った会話ID(1会話1回まで・往復ループ禁止) */
  private fallbackUsedFor: string | null = null;
  /**
   * M17-2: 自律モード(承認なし自動実行)。メモリ内のみ=アプリ再起動で必ずOFF。
   * セッション切替・新規でもOFFに戻す(事故防止)。config には保存しない
   */
  private autonomousMode = false;
  /** 保存の直列化(fold と save が並行実行で交錯しないように) */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AgentServiceDeps) {
    this.broker = new ApprovalBroker(
      (req) => {
        this.pendingApprovals.set(req.id, req);
        deps.bus.publish('approval:request', req);
      },
      (id, decision) => {
        this.pendingApprovals.delete(id);
        deps.bus.publish('approval:resolved', { id, decision });
      },
    );
    this.evolution = deps.createEvolution({
      requestPromotionApproval: (job, diff, warnings) =>
        new Promise<boolean>((resolve) => {
          this.pendingPromotions.set(job.id, resolve);
          const event: PromotionRequestEvent = {
            kind: 'promotion_request',
            jobId: job.id,
            toolName: job.toolName ?? '(不明)',
            diff,
            warnings,
          };
          this.pendingPromotionEvents.set(job.id, event);
          deps.bus.publish('evolution:event', event);
        }),
      onEvent: (e) => deps.bus.publish('evolution:event', e),
    });
  }

  // ---- provider ----

  createProvider(): LLMProvider | string {
    if (this.deps.providerFactory) return this.deps.providerFactory();
    const cfg = this.deps.config.get();
    if (cfg.provider === 'openai') {
      const key = this.deps.secrets.get('openai');
      if (!key) return 'OpenAI APIキーが未設定(設定画面から登録)';
      return new OpenAIProvider(key, cfg.model || DEFAULT_OPENAI_MODEL);
    }
    const key = this.deps.secrets.get('anthropic');
    if (!key) return 'Anthropic APIキーが未設定(設定画面から登録)';
    return new AnthropicProvider(key, cfg.model || DEFAULT_ANTHROPIC_MODEL);
  }

  // ---- M18: モデル自動切替(役割ベース割当) ----

  /** 有効な modelPolicy(enabled=true)。無効・未設定なら null(=従来の単一モデル挙動) */
  private modelPolicy(): ModelPolicy | null {
    const p = this.deps.config.get().modelPolicy;
    return p !== undefined && p.enabled ? p : null;
  }

  /** 帯の実効 provider+model。escalation 未指定は planner を使う。policy 無効なら null */
  private bandLLM(band: ModelBandName): { provider: ProviderId; model: string } | null {
    const p = this.modelPolicy();
    if (!p) return null;
    const b = band === 'escalation' ? (p.escalation ?? p.planner) : p[band];
    return { provider: b.provider, model: b.model.trim() !== '' ? b.model : DEFAULT_MODELS[b.provider] };
  }

  /**
   * 帯プロバイダの生成。キー未登録は帯名入りのメッセージ(呼び出し側が警告カードに使う)。
   * キー判定を factory 差し替えより先に行う(未登録警告の経路もテスト可能にするため)
   */
  private createBandProvider(band: ModelBandName): LLMProvider | string {
    const llm = this.bandLLM(band);
    if (!llm) return this.createProvider();
    const key = this.deps.secrets.get(llm.provider);
    if (!key) return `モデル自動切替: ${band}帯(${llm.provider}/${llm.model})のAPIキーが未設定`;
    if (this.deps.bandProviderFactory) return this.deps.bandProviderFactory(band, llm.provider, llm.model);
    return llm.provider === 'openai'
      ? new OpenAIProvider(key, llm.model)
      : new AnthropicProvider(key, llm.model);
  }

  /** 進化ジョブ(AgentJobRunner)用。キー未設定は例外にする */
  createProviderOrThrow(): LLMProvider {
    const provider = this.createProvider();
    if (typeof provider === 'string') throw new Error(provider);
    return provider;
  }

  // ---- workspace / executor ----

  getWorkspace(): string {
    const ws = this.deps.config.get().workspace;
    return ws && ws.trim() !== '' ? ws : this.deps.defaultWorkspace();
  }

  private getScopePolicy(): ScopePolicy {
    return {
      mode: this.deps.config.get().scopeMode,
      workspaceRoot: this.getWorkspace(),
      deny: this.deps.denyPaths,
    };
  }

  private executorDeps(): ExecutorDeps {
    return {
      registry: this.deps.registry,
      broker: this.broker,
      getAutoApprove: () => this.deps.config.get().autoApprove,
      getScopePolicy: () => this.getScopePolicy(),
      audit: (e) => this.deps.audit.append(e),
      // M11-4: 編集後フック。fullPc でも cwd は workspace に固定する
      getPostEditHook: () => {
        const cmd = this.deps.config.get().postEditHook;
        return cmd !== undefined && cmd.trim() !== ''
          ? { command: cmd, cwd: this.getWorkspace() }
          : null;
      },
      // M14-5: fullPc の「セッション中許可(このフォルダ)」(既定OFF=M9どおり毎回承認)
      getFullPcAllowSession: () => this.deps.config.get().fullPcAllowSession === true,
      // M17-2: 自律モード。進化ジョブは executorDeps() を経由しないため波及しない
      getAutonomous: () => this.autonomousMode,
    };
  }

  // ---- 自律モード(M17-2) ----

  getAutonomous(): boolean {
    return this.autonomousMode;
  }

  /** ON/OFF の切替。全切替を監査に記録し、全画面(renderer/remote)へ通知する */
  setAutonomous(on: boolean): { on: boolean } {
    if (this.autonomousMode === on) return { on };
    this.autonomousMode = on;
    this.deps.audit.append({
      tool: 'autonomous-mode',
      scope: 'system',
      paths: [],
      event: 'result',
      detail: on ? 'on' : 'off',
      autonomous: true,
    });
    this.deps.bus.publish('autonomous:changed', { on });
    return { on };
  }

  /** workspace 変更に追従してチェックポイント管理を作り直す(未設定なら null = 無効) */
  private getCheckpoints(): CheckpointsLike | null {
    const factory = this.deps.createCheckpoints;
    if (!factory) return null;
    const ws = this.getWorkspace();
    if (!this.checkpointsCache || this.checkpointsCache.workspace !== ws) {
      this.checkpointsCache = factory(ws);
    }
    return this.checkpointsCache;
  }

  private evolutionContext() {
    return {
      requestCapability: async (description: string, expectedIO: string) => ({
        jobId: await this.evolution.enqueue({ description, expectedIO }),
      }),
    };
  }

  // ---- chat ----

  private emitChat(event: AgentEvent): void {
    if (event.kind === 'status') this.lastStatus = event.status;
    this.deps.bus.publish('chat:event', event);
  }

  /**
   * M16-1: 現在のメイン会話が使う provider+model(切替検知・lastLLM 記録用)。
   * M18: modelPolicy 有効時は planner 帯(=メイン会話の実体)を指す
   */
  private currentLLM(): { provider: ProviderId; model: string } {
    const planner = this.bandLLM('planner');
    if (planner) return planner;
    const cfg = this.deps.config.get();
    return { provider: cfg.provider, model: cfg.model || DEFAULT_MODELS[cfg.provider] };
  }

  /**
   * M16-1: プロバイダ/モデル切替の検知。切替時は prompt cache が無効になり長い履歴の
   * 再送が高くつくため、閾値(既定24k)超なら初回LLM呼び出しの前に圧縮しておく。
   * 戻り値は情報カードに出すメッセージ(切替なしなら null)
   */
  private async compactOnSwitch(provider: LLMProvider, signal: AbortSignal): Promise<string | null> {
    const current = this.currentLLM();
    const prev = this.conversation?.lastLLM;
    if (this.conversation) this.conversation.lastLLM = current;
    if (!prev || (prev.provider === current.provider && prev.model === current.model)) return null;
    // 実測が古い(切替直後・ロード直後)可能性があるため推定との大きい方で判定する
    const measured = Math.max(this.lastPromptTokens, estimateTokens(this.history));
    const compacted = await this.maybeCompact(provider, signal, {
      thresholdTokens: DEFAULT_COMPACTION_THRESHOLD,
      measuredTokens: measured,
    });
    const label = `${prev.provider}/${prev.model} → ${current.provider}/${current.model}`;
    return compacted
      ? `モデル切替を検知(${label})。キャッシュが効かなくなるため履歴を圧縮しました`
      : `モデル切替を検知(${label})。履歴が小さいため圧縮は不要でした`;
  }

  /**
   * M13-1: 実測トークン(直近APIコールの input+cache_read)がモデル上限の70%を超えたら
   * 履歴を圧縮する。要約で消える範囲の普遍的知見は AMATERAS.md の学習メモへ退避される。
   * 圧縮したら lastPromptTokens をリセット(次のAPIコールで再実測されるまで未知のため)
   */
  private async maybeCompact(
    provider: LLMProvider,
    signal: AbortSignal,
    override?: { thresholdTokens: number; measuredTokens: number },
  ): Promise<boolean> {
    // M18: policy有効時のメイン会話は planner 帯のモデル上限で判定する(currentLLMが吸収)
    const threshold =
      override?.thresholdTokens ?? Math.floor(contextLimitFor(this.currentLLM().model) * 0.7);
    const compacted = await compactHistory(provider, this.history, {
      signal,
      measuredTokens: override?.measuredTokens ?? this.lastPromptTokens,
      thresholdTokens: threshold,
      onMemoryEscape: (text) => {
        try {
          appendLearnedMemory(this.getWorkspace(), text);
        } catch (err) {
          console.error('[memory] 退避失敗:', err instanceof Error ? err.message : err);
        }
      },
    });
    if (compacted) this.lastPromptTokens = 0;
    return compacted;
  }

  // ---- セッション永続化(M12-1) ----

  /**
   * 現在の会話を userData/sessions へ保存する(fire-and-forget・直列化)。
   * 履歴JSONが上限超過なら provider で畳んでから保存。保存失敗でチャットは止めない。
   */
  private persistSession(provider?: LLMProvider): void {
    const store = this.deps.sessions;
    const conv = this.conversation;
    if (!store || !conv) return;
    this.persistChain = this.persistChain.then(async () => {
      try {
        if (provider) await foldHistoryIfOversize(provider, this.history);
        const data: SessionData = {
          version: SESSION_SCHEMA_VERSION,
          id: conv.id,
          title: conv.title,
          workspace: this.getWorkspace(),
          createdAt: conv.createdAt,
          updatedAt: new Date().toISOString(),
          history: this.history,
          ...(conv.lastLLM !== undefined ? { lastLLM: conv.lastLLM } : {}),
        };
        await store.save(data);
      } catch (err) {
        console.error('[sessions] 保存失敗:', err instanceof Error ? err.message : err);
      }
    });
  }

  async sessionsList(): Promise<SessionMeta[]> {
    return (await this.deps.sessions?.list()) ?? [];
  }

  async sessionLoad(id: string): Promise<SessionLoadResult> {
    if (this.activeRun) return { ok: false, message: 'エージェント実行中はセッションを切り替えられない' };
    const store = this.deps.sessions;
    if (!store) return { ok: false, message: 'セッション永続化が無効' };
    const data = await store.load(id);
    if (!data) return { ok: false, message: 'セッションが見つからない(または壊れている)' };
    return this.applyLoadedSession(data);
  }

  /**
   * M15.1: リモート(スマホ)用のセッション切替。sessionLoad に加えて、セッションに
   * 記録された workspace へ自動で追従する(desktopの左ペインと同じ挙動)。
   * 任意パスへの変更ではなく「既存セッションの記録値」限定のため、リモートへ公開してよい
   * (settings:set 自体は引き続き非公開)。実行中ガードは sessionLoad 内で強制される
   */
  async sessionOpen(id: string): Promise<SessionLoadResult> {
    if (this.activeRun) return { ok: false, message: 'エージェント実行中はセッションを切り替えられない' };
    const store = this.deps.sessions;
    if (!store) return { ok: false, message: 'セッション永続化が無効' };
    const data = await store.load(id);
    if (!data) return { ok: false, message: 'セッションが見つからない(または壊れている)' };
    const cfg = this.deps.config.get();
    if (data.workspace !== '' && data.workspace !== (cfg.workspace ?? '') && this.deps.config.set) {
      this.deps.config.set({ ...cfg, workspace: data.workspace });
    }
    return this.applyLoadedSession(data);
  }

  private applyLoadedSession(data: SessionData): SessionLoadResult {
    // M17-2: セッション切替で自律モードは必ずOFF(事故防止・セッション単位の状態)
    this.setAutonomous(false);
    // 履歴配列は loop と参照共有しているため、置換ではなく中身を差し替える
    this.history.length = 0;
    this.history.push(...data.history);
    this.conversation = {
      id: data.id,
      title: data.title,
      createdAt: data.createdAt,
      ...(data.lastLLM !== undefined ? { lastLLM: data.lastLLM } : {}),
    };
    // 実測値は次のAPIコールまで無いので推定で近似(M13-1)
    this.lastPromptTokens = estimateTokens(this.history);
    return { ok: true, history: toHistoryView(this.history) };
  }

  sessionNew(): { ok: boolean; message?: string } {
    if (this.activeRun) return { ok: false, message: 'エージェント実行中は新規セッションを開始できない' };
    this.history.length = 0;
    this.conversation = null;
    this.lastPromptTokens = 0;
    // M17-2: 新規セッションでも自律モードはOFFへ戻す(セッション単位の状態)
    this.setAutonomous(false);
    return { ok: true };
  }

  /** M15-2: タイトル+本文の部分一致検索 */
  async sessionsSearch(query: string): Promise<SessionMeta[]> {
    return (await this.deps.sessions?.search?.(query)) ?? [];
  }

  /** M15-2: セッション名の変更(表示中の会話ならメモリ側のタイトルも同期) */
  async sessionRename(id: string, title: string): Promise<boolean> {
    const ok = (await this.deps.sessions?.rename?.(id, title)) ?? false;
    if (ok && this.conversation?.id === id) {
      this.conversation = { ...this.conversation, title: title.trim().slice(0, 100) };
    }
    return ok;
  }

  async sessionDelete(id: string): Promise<void> {
    await this.deps.sessions?.delete(id);
    // 表示中の会話を消した場合はメモリ側もリセット(実行中は触らない)
    if (this.conversation?.id === id && !this.activeRun) {
      this.history.length = 0;
      this.conversation = null;
    }
  }

  /** M14-2: ctx.screenshot の注入(captureUrl 未設定なら注入しない=ツール側で明示エラー) */
  private screenshotContext(): { screenshot: { capture: NonNullable<AgentServiceDeps['captureUrl']> } } | Record<string, never> {
    const capture = this.deps.captureUrl;
    return capture ? { screenshot: { capture } } : {};
  }

  chatSend(text: string, mode: ChatMode, images?: ChatImageInput[]): { sessionId: string } {
    const planMode = mode === 'plan';
    const sessionId = randomUUID();
    const emit = (event: AgentEvent): void => this.emitChat(event);

    if (this.activeRun) {
      emit({ kind: 'error', sessionId, message: '別の実行が進行中' });
      emit({ kind: 'status', sessionId, status: 'error' });
      return { sessionId };
    }
    // M18: policy有効時のメイン会話は planner 帯。無効時は従来の単一モデル
    const policy = this.modelPolicy();
    const provider = policy ? this.createBandProvider('planner') : this.createProvider();
    if (typeof provider === 'string') {
      emit({ kind: 'error', sessionId, message: provider });
      emit({ kind: 'status', sessionId, status: 'error' });
      return { sessionId };
    }
    // M18: worker/escalation 帯のキー未登録は実行前に警告(横断構成の取りこぼし防止)。
    // worker はメイン(planner)のプロバイダで代行して続行する
    let workerProvider: LLMProvider = provider;
    // M19: レビュー差し戻し3ラウンド目以降のfixに使う(escalation帯。無ければworkerで代行)
    let escalationProvider: LLMProvider = provider;
    if (policy) {
      const w = this.createBandProvider('worker');
      if (typeof w === 'string') {
        emit({ kind: 'info', sessionId, message: `⚠ ${w} — サブエージェントは planner 帯で代行します` });
      } else {
        workerProvider = w;
      }
      const e = this.createBandProvider('escalation');
      if (typeof e === 'string') {
        emit({ kind: 'info', sessionId, message: `⚠ ${e} — 格上げは無効になります` });
      } else {
        escalationProvider = e;
      }
    }
    // M19: レビュー・ゲートの実行状況(マイルストーン発動が無かったrunは完了時に1回縮退)
    let reviewRanThisRun = false;
    let producedOutput = false;

    const ac = new AbortController();
    this.activeRun = { sessionId, ac };
    // M14-2: 添付画像はテキストの後ろに image ブロックとして積む
    this.history.push({
      role: 'user',
      content: [
        { type: 'text', text },
        ...(images ?? []).map((img): ChatMessage['content'][number] => ({ type: 'image', ...img })),
      ],
    });
    // M12-1: 会話の永続化メタ(初回送信時に確定。タイトルは先頭行)
    if (!this.conversation) {
      this.conversation = {
        id: randomUUID(),
        title: (text.split('\n')[0] ?? text).slice(0, 60),
        createdAt: new Date().toISOString(),
      };
    }
    // M16-2: フォールバック発動後は以降の圧縮・保存もこのプロバイダで行う
    let runProvider: LLMProvider = provider;

    this.persistSession(provider); // ユーザーメッセージを即座に保存(クラッシュ耐性)
    // M12-1: 各ターン完了(assistantメッセージ確定)ごとに随時保存する
    const emitWithPersist = (event: AgentEvent): void => {
      emit(event);
      if (event.kind === 'message_done') this.persistSession(runProvider);
    };
    // M11-1: 設定された maxTurns をループへ配線(未設定ならループ既定の30)
    const maxTurns = this.deps.config.get().maxTurns;

    /**
     * M16-2: 課金系エラー時のフォールバック。1会話1回・同一先への切替禁止。
     * 発動時は警告カード+audit記録+事前compaction(キャッシュ前提が崩れるため)
     */
    const acquireFallback = async (reason: string): Promise<LLMProvider | null> => {
      const fb = this.deps.config.get().fallback;
      if (!fb || fb.enabled !== true) return null;
      const convKey = this.conversation?.id ?? sessionId;
      if (this.fallbackUsedFor === convKey) return null;
      const current = this.currentLLM();
      const fbModel = fb.model.trim() !== '' ? fb.model : DEFAULT_MODELS[fb.provider];
      if (fb.provider === current.provider && fbModel === current.model) return null;

      let next: LLMProvider;
      if (this.deps.fallbackProviderFactory) {
        next = this.deps.fallbackProviderFactory(fb.provider, fbModel);
      } else {
        const key = this.deps.secrets.get(fb.provider);
        if (!key) {
          emit({
            kind: 'info',
            sessionId,
            message: `フォールバック先(${fb.provider})のAPIキーが未設定のため切り替えできない`,
          });
          return null;
        }
        next =
          fb.provider === 'openai'
            ? new OpenAIProvider(key, fbModel)
            : new AnthropicProvider(key, fbModel);
      }

      this.fallbackUsedFor = convKey;
      this.deps.audit.append({
        tool: 'provider-fallback',
        scope: 'system',
        paths: [],
        event: 'result',
        detail: `${current.provider}/${current.model} → ${fb.provider}/${fbModel}: ${reason.slice(0, 160)}`,
      });
      emit({
        kind: 'info',
        sessionId,
        message: `⚠ 残高/課金エラーを検知したため、フォールバック(${fb.provider}/${fbModel})へ切り替えて続行します: ${reason}`,
      });
      // 切替でprompt cacheが無効になるため、長い履歴は先に圧縮する(M16-1と同じ閾値)
      try {
        await this.maybeCompact(next, ac.signal, {
          thresholdTokens: DEFAULT_COMPACTION_THRESHOLD,
          measuredTokens: Math.max(this.lastPromptTokens, estimateTokens(this.history)),
        });
      } catch {
        /* 圧縮失敗でも続行 */
      }
      if (this.conversation) {
        this.conversation.lastLLM = { provider: fb.provider, model: fbModel };
      }
      runProvider = next;
      return next;
    };

    void (async () => {
      // M16-1: プロバイダ/モデル切替を検知したら、キャッシュ前提が崩れるため先に圧縮する
      try {
        const switchInfo = await this.compactOnSwitch(provider, ac.signal);
        if (switchInfo) emit({ kind: 'info', sessionId, message: switchInfo });
      } catch {
        /* 切替時圧縮の失敗は無視して通常応答へ進む */
      }
      // 履歴が閾値超なら圧縮してから応答する(M8-1、M13-1で実測トークントリガー化)。
      // 要約失敗は致命的でないため、失敗しても圧縮せず継続する。
      try {
        const compacted = await this.maybeCompact(provider, ac.signal);
        if (compacted) emit({ kind: 'status', sessionId, status: 'calling_llm' });
      } catch {
        /* 圧縮失敗は無視して通常応答へ進む */
      }
      const status = await runAgentLoop(
        {
          provider,
          // プランモードではツール定義を渡さない(モデルがtool_useを出せない)。
          // 併せて loop 側 planMode でも実行を機械的に禁止する(二重防御)。
          tools: planMode ? { list: () => [] } : this.deps.registry,
          executeTool: async (name, input, ctx) => {
            // M19: plan 書き込み前の計画内容(マイルストーン完了検出用)
            const planBefore =
              name === 'plan' && this.deps.config.get().reviewGate?.enabled === true
                ? readProjectPlan(this.getWorkspace())
                : null;
            const result = await executeToolWithApproval(this.executorDeps(), name, input, {
              ...ctx,
              evolution: this.evolutionContext(),
              processes: this.processes,
              ...this.screenshotContext(),
              subagent: {
                // M18: サブエージェントは worker 帯(policy無効時はメインと同一)
                run: (task, signal) =>
                  runSubAgent(
                    {
                      provider: workerProvider,
                      tools: this.deps.registry,
                      cwd: this.getWorkspace(),
                      acquireFallback: this.acquireChildFallback(sessionId),
                    },
                    task,
                    signal,
                  ),
                // M12-3: 最大3並列(read/work)。work は executor 経由で承認・スコープが効く
                runParallel: (tasks, subMode, signal) =>
                  this.runParallelSubAgents(workerProvider, sessionId, tasks, subMode, signal),
              },
            });
            // M11-3: 書き込み/実行系ツールの成功直後に自動チェックポイント(メインループのみ)。
            // 失敗してもツール結果・ループは止めない(manager 側でログ済み)
            const risk = this.deps.registry.get(name)?.risk;
            if (result.isError !== true && (risk === 'write' || risk === 'exec')) {
              producedOutput = true;
              await this.getCheckpoints()
                ?.snapshot(sessionId, `${name} 実行後`)
                .catch(() => null);
            }
            // M19: マイルストーン完了(- [ ]→- [x])を検知したらレビュー・ゲートを同期実行。
            // 要約を tool_result に追記するので、メインのモデル自身も合否を認識できる
            if (planBefore !== null && result.isError !== true) {
              const done = newlyCompleted(planBefore, readProjectPlan(this.getWorkspace()));
              if (done.length > 0) {
                reviewRanThisRun = true;
                const summary = await this.runReviewGate({
                  sessionId,
                  milestone: done.join(' / '),
                  userRequest: text,
                  signal: ac.signal,
                  reviewProvider: runProvider,
                  workerProvider,
                  escalationProvider,
                });
                if (summary !== null) {
                  return { ...result, content: `${result.content}\n\n[品質レビュー] ${summary}` };
                }
              }
            }
            return result;
          },
          emit: emitWithPersist,
          // プロジェクト記憶(AMATERAS.md)と現在の計画(AMATERAS_PLAN.md)を
          // system プロンプトへ注入する(M8-2 / M12-2)
          systemPrompt:
            composePlanSection(
              composeSystemPrompt(SYSTEM_PROMPT, readProjectMemory(this.getWorkspace())),
              readProjectPlan(this.getWorkspace()),
            ) +
            (policy ? POLICY_HINT : '') +
            (planMode ? PLAN_SUFFIX : ''),
          cwd: this.getWorkspace(),
          planMode,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          // M13-1: ループ内compaction(長い自走の途中でも実測トークンで圧縮)
          compact: async (measured) => {
            this.lastPromptTokens = measured;
            try {
              await this.maybeCompact(runProvider, ac.signal);
            } catch {
              /* 圧縮失敗でループは止めない */
            }
          },
          // M16-1: 1ターン完結でも実測値を保持する(切替時compactionの判定に使う)
          onUsage: (measured) => {
            this.lastPromptTokens = measured;
          },
          // M16-2: 課金系エラー時のフォールバック(transientリトライはloop内蔵)
          acquireFallback,
        },
        sessionId,
        this.history,
        ac.signal,
      );
      // M19: 計画を使わなかった短いタスクは完了時に1回だけレビュー(縮退モード)。
      // 成果物(write/exec成功)が無い会話は対象外
      if (
        status === 'done' &&
        !reviewRanThisRun &&
        producedOutput &&
        this.deps.config.get().reviewGate?.enabled === true
      ) {
        await this.runReviewGate({
          sessionId,
          milestone: '完成時レビュー',
          userRequest: text,
          signal: ac.signal,
          reviewProvider: runProvider,
          workerProvider,
          escalationProvider,
        });
      }
      // M11-3: ループ完了時にも1回スナップショット(直近ツール以降の変更を確定)
      await this.getCheckpoints()
        ?.snapshot(sessionId, `セッション終了(${status})`)
        .catch(() => null);
      // M12-1: 終了時に最終状態を保存(tool_result 追記分を含めて確定)
      this.persistSession(runProvider);
      return status;
    })().finally(() => {
      this.activeRun = null;
    });

    return { sessionId };
  }

  /**
   * M16-2×M18: サブエージェント(worker/escalation帯)用の課金エラーフォールバック。
   * メインの acquireFallback と同じ制限を共有(1会話1回・fallbackUsedFor)するが、
   * メインの実行プロバイダや lastLLM には触れない(子ループ内だけ切り替える)。
   * 子履歴は小さいため切替前compactionは省く
   */
  private acquireChildFallback(sessionId: string): (reason: string) => Promise<LLMProvider | null> {
    return async (reason) => {
      const fb = this.deps.config.get().fallback;
      if (!fb || fb.enabled !== true) return null;
      const convKey = this.conversation?.id ?? sessionId;
      if (this.fallbackUsedFor === convKey) return null;
      const fbModel = fb.model.trim() !== '' ? fb.model : DEFAULT_MODELS[fb.provider];
      let next: LLMProvider;
      if (this.deps.fallbackProviderFactory) {
        next = this.deps.fallbackProviderFactory(fb.provider, fbModel);
      } else {
        const key = this.deps.secrets.get(fb.provider);
        if (!key) return null;
        next =
          fb.provider === 'openai' ? new OpenAIProvider(key, fbModel) : new AnthropicProvider(key, fbModel);
      }
      this.fallbackUsedFor = convKey;
      this.deps.audit.append({
        tool: 'provider-fallback',
        scope: 'system',
        paths: [],
        event: 'result',
        detail: `subagent → ${fb.provider}/${fbModel}: ${reason.slice(0, 160)}`,
      });
      this.emitChat({
        kind: 'info',
        sessionId,
        message: `⚠ サブエージェントで残高/課金エラーを検知したため、フォールバック(${fb.provider}/${fbModel})へ切り替えて続行します: ${reason}`,
      });
      return next;
    };
  }

  /**
   * M18: work サブエージェントの格上げ依存。policy 無効・escalation帯キー未設定なら undefined
   * (=格上げ無効)。格上げ前に子履歴を compaction 経由(キャッシュ前提が変わるため)
   */
  private buildEscalateDeps(sessionId: string):
    | {
        provider: LLMProvider;
        maxPerTask: number;
        compact: (history: ChatMessage[], signal: AbortSignal) => Promise<void>;
        onEscalate: (id: number, attempt: number, reason: string) => void;
      }
    | undefined {
    const policy = this.modelPolicy();
    if (!policy) return undefined;
    const max = policy.maxEscalationsPerTask ?? 1;
    if (max <= 0) return undefined;
    const esc = this.createBandProvider('escalation');
    if (typeof esc === 'string') return undefined; // キー未設定の警告は chatSend 冒頭で済み
    return {
      provider: esc,
      maxPerTask: max,
      compact: async (history, signal) => {
        await compactHistory(esc, history, {
          signal,
          measuredTokens: estimateTokens(history),
          thresholdTokens: DEFAULT_COMPACTION_THRESHOLD,
        });
      },
      onEscalate: (id, attempt, reason) => {
        const llm = this.bandLLM('escalation');
        this.deps.audit.append({
          tool: 'model-escalation',
          scope: 'system',
          paths: [],
          event: 'result',
          detail: `subagent#${id} attempt=${attempt} → ${llm?.provider}/${llm?.model}: ${reason.slice(0, 160)}`,
        });
        this.emitChat({
          kind: 'info',
          sessionId,
          message: `⤴ サブエージェント#${id} の実行が難航(${reason})。上位モデル(${llm?.provider}/${llm?.model})へ格上げして再試行します(${attempt}回目)`,
        });
      },
    };
  }

  /**
   * M19: 品質レビュー・ゲート1サイクル(レビュー → 不合格なら差し戻し → 再レビュー)。
   * 戻り値は plan の tool_result 等に追記する日本語の要約(無効・キャンセル時は null)。
   * fix は runParallelSubAgents(work) 経由なので、承認・スコープ・M18エスカレーション・
   * M16子フォールバックがそのまま効く。3ラウンド目以降の fix は escalation 帯を直接使う
   */
  private async runReviewGate(args: {
    sessionId: string;
    milestone: string;
    userRequest: string;
    signal: AbortSignal;
    reviewProvider: LLMProvider;
    workerProvider: LLMProvider;
    escalationProvider: LLMProvider;
  }): Promise<string | null> {
    const cfg = this.deps.config.get().reviewGate;
    if (cfg === undefined || !cfg.enabled || args.signal.aborted) return null;
    const ws = this.getWorkspace();
    const target: ReviewTarget = {
      milestone: args.milestone,
      userRequest: args.userRequest,
      planContent: readProjectPlan(ws),
    };
    const emitCard = (card: ReviewCardPayload): void => {
      this.emitChat({ kind: 'review', sessionId: args.sessionId, ...card });
      this.deps.audit.append({
        tool: 'review-gate',
        scope: 'system',
        paths: [],
        event: 'result',
        detail: `milestone="${args.milestone.slice(0, 80)}" round=${card.round} avg=${card.average} pass=${card.pass} findings=${card.findings.length}`,
      });
    };

    const result = await runReviewCycle({
      config: cfg,
      review: (round) =>
        runReviewer(
          {
            provider: args.reviewProvider,
            tools: this.deps.registry,
            cwd: ws,
            axes: cfg.axes,
            threshold: cfg.threshold,
            ...(this.deps.captureUrl !== undefined ? { captureUrl: this.deps.captureUrl } : {}),
          },
          target,
          round,
          args.signal,
        ),
      fix: async (card, round) => {
        // worker修正が2回失敗した後(3ラウンド目〜)は escalation 帯へ格上げして直す(M18連動)
        const provider = round >= 3 ? args.escalationProvider : args.workerProvider;
        await this.runParallelSubAgents(
          provider,
          args.sessionId,
          [buildFixTask(target, card)],
          'work',
          args.signal,
        );
      },
      onCard: emitCard,
      signal: args.signal,
    });

    if (args.signal.aborted) return null;

    if (result.reviewFailed && result.final === null) {
      this.emitChat({
        kind: 'info',
        sessionId: args.sessionId,
        message: '品質レビューを実行できなかった(採点出力が得られず)。今回は素通しで続行します',
      });
      return 'レビュー実行失敗(素通し)';
    }

    const final = result.final!;
    if (result.resolved) {
      return result.fixRounds > 0
        ? `合格 平均${final.average}/5(差し戻し${result.fixRounds}回で改善)`
        : `合格 平均${final.average}/5`;
    }

    // 上限到達でも閾値未満: 残課題を提示。自律モードOFFなら承認を仰ぐ
    emitCard({ ...final, unresolved: true });
    const remaining = final.findings
      .map((f, i) => `${i + 1}. ${f.file}(${f.location}): ${f.problem} → ${f.fix}`)
      .join('\n');
    if (this.autonomousMode) {
      this.emitChat({
        kind: 'info',
        sessionId: args.sessionId,
        message: `⚠ 品質レビュー: 差し戻し上限(${cfg.maxRoundsPerMilestone}回)でも閾値未満(平均${final.average}/5)。残課題${final.findings.length}件を許容して続行します(自律モード)`,
      });
    } else {
      const decision = await this.broker.request(
        {
          toolName: 'review-gate',
          risk: 'safe',
          inputPreview: remaining.slice(0, 1500) || final.summary.slice(0, 1500),
          warnings: [
            `品質レビュー: 差し戻し上限(${cfg.maxRoundsPerMilestone}回)に達しても閾値未満(平均${final.average}/5)。残課題を許容して先へ進みますか?(拒否した場合は追加の修正指示をチャットで送ってください)`,
          ],
        },
        args.signal,
      );
      this.emitChat({
        kind: 'info',
        sessionId: args.sessionId,
        message:
          decision === 'deny'
            ? '品質レビューの残課題が許容されなかった。追加の修正指示をチャットで送ってください'
            : '品質レビューの残課題を許容して続行します',
      });
    }
    return `上限到達・残課題${final.findings.length}件(平均${final.average}/5)`;
  }

  /**
   * M12-3: 並列サブエージェント。fan-out 直前に自動チェックポイントを作り、
   * work モードでは write 衝突テーブルを全子で共有する。親 signal で全子キャンセル。
   * (public なのはテストのため。通常は chatSend 内の ctx.subagent.runParallel 経由)
   */
  async runParallelSubAgents(
    provider: LLMProvider,
    sessionId: string,
    tasks: string[],
    mode: 'read' | 'work',
    signal: AbortSignal,
  ): Promise<string[]> {
    const limited = tasks.slice(0, MAX_PARALLEL_SUBAGENTS);
    await this.getCheckpoints()
      ?.snapshot(sessionId, `サブエージェント並列実行前(${mode}×${limited.length})`)
      .catch(() => null);
    const locks = new WriteLockTable();
    const onUpdate = (u: SubAgentUpdate): void => this.deps.bus.publish('agent:sub_update', u);
    const rawTurns = this.deps.config.get().subAgentMaxTurns;
    const maxTurns =
      rawTurns !== undefined ? Math.min(100, Math.max(1, Math.round(rawTurns))) : undefined;
    // M18: 格上げ(policy有効時のみ)とサブ用フォールバック
    const escalate = this.buildEscalateDeps(sessionId);
    const acquireFallback = this.acquireChildFallback(sessionId);

    return Promise.all(
      limited.map((task) => {
        const id = ++this.subAgentSeq;
        if (mode === 'work') {
          return runWorkSubAgent(
            {
              provider,
              tools: this.deps.registry,
              cwd: this.getWorkspace(),
              executeTool: (name, input, ctx) =>
                executeToolWithApproval(this.executorDeps(), name, input, {
                  ...ctx,
                  ...this.screenshotContext(),
                }),
              onUpdate,
              locks,
              acquireFallback,
              ...(escalate !== undefined ? { escalate } : {}),
              ...(maxTurns !== undefined ? { maxTurns } : {}),
            },
            id,
            task,
            signal,
          );
        }
        // read の並列: 従来の読み取り専用子を進行イベント付きで走らせる
        const label = task.length > 120 ? `${task.slice(0, 120)}…` : task;
        onUpdate({ id, task: label, mode: 'read', status: 'running' });
        return runSubAgent(
          { provider, tools: this.deps.registry, cwd: this.getWorkspace(), acquireFallback },
          task,
          signal,
        ).then((summary) => {
          onUpdate({
            id,
            task: label,
            mode: 'read',
            status: signal.aborted ? 'cancelled' : 'done',
            summaryTail: summary.slice(-200),
          });
          return summary;
        });
      }),
    );
  }

  chatCancel(sessionId: string): void {
    if (this.activeRun?.sessionId === sessionId) {
      this.activeRun.ac.abort();
      // M11-2: セッションキャンセルでバックグラウンドプロセスも全て止める(設計どおり)
      this.processes.killAll();
    }
  }

  /** アプリ終了時の後始末(index.ts の will-quit から呼ばれる) */
  shutdown(): void {
    this.processes.killAll();
  }

  // ---- 承認 ----

  approvalRespond(id: string, decision: ApprovalDecision): void {
    this.broker.respond(id, decision);
  }

  getPendingApprovals(): ApprovalRequestPayload[] {
    return [...this.pendingApprovals.values()];
  }

  // ---- ツール ----

  toolsList(): { tools: ToolInfo[]; errors: PluginErrorInfo[] } {
    return {
      tools: this.deps.registry.list().map((p) => ({
        name: p.name,
        description: p.description,
        risk: p.risk,
        warnings: p.warnings ?? [],
      })),
      errors: this.deps.registry.errors,
    };
  }

  async toolsReload(): Promise<{ tools: ToolInfo[]; errors: PluginErrorInfo[] }> {
    await this.deps.registry.reload();
    return this.toolsList();
  }

  async toolsExecute(name: string, inputJson: string): Promise<ToolExecResultPayload> {
    let input: unknown;
    try {
      input = inputJson.trim() === '' ? {} : JSON.parse(inputJson);
    } catch {
      return { content: '入力がJSONとして不正', isError: true };
    }
    const ac = new AbortController();
    const result = await executeToolWithApproval(
      this.executorDeps(),
      name,
      input,
      // chatSend と同じく evolution / processes を注入する(手動実行でも同じ能力を持つ)
      {
        cwd: this.getWorkspace(),
        signal: ac.signal,
        log: () => {},
        evolution: this.evolutionContext(),
        processes: this.processes,
        ...this.screenshotContext(),
      },
    );
    return { content: result.content, isError: result.isError === true };
  }

  // ---- ファイルプレビュー(M15-3) ----

  async filePreview(path: string): Promise<FilePreviewResult> {
    return previewFile(path, {
      workspaceRoot: this.getWorkspace(),
      scopeMode: this.deps.config.get().scopeMode,
      deny: this.deps.denyPaths,
    });
  }

  // ---- チェックポイント(M11-3) ----

  async checkpointList(): Promise<CheckpointInfo[]> {
    return (await this.getCheckpoints()?.list()) ?? [];
  }

  async checkpointRestore(sha: string): Promise<CheckpointRestoreResult> {
    if (this.activeRun) {
      return { ok: false, message: 'エージェント実行中は復元できない(完了かキャンセル後に実行)' };
    }
    const ckpt = this.getCheckpoints();
    if (!ckpt) {
      return { ok: false, message: 'チェックポイント機能が無効(workspace が git リポジトリでない等)' };
    }
    return ckpt.restore(sha);
  }

  // ---- 進化 ----

  evolutionList(): EvolutionJobSummary[] {
    return this.evolution.list();
  }

  async evolutionEnqueue(description: string, expectedIO: string): Promise<{ jobId: number }> {
    return { jobId: await this.evolution.enqueue({ description, expectedIO }) };
  }

  evolutionPromoteRespond(jobId: number, approved: boolean): void {
    const resolve = this.pendingPromotions.get(jobId);
    if (resolve) {
      this.pendingPromotions.delete(jobId);
      this.pendingPromotionEvents.delete(jobId);
      resolve(approved);
    }
  }

  getPendingPromotionRequests(): PromotionRequestEvent[] {
    return [...this.pendingPromotionEvents.values()];
  }

  // ---- 状態(リモートUIの snapshot / /api/status 用) ----

  getStatus(): AgentStatusView {
    return {
      status: this.activeRun ? this.lastStatus : 'idle',
      activeSessionId: this.activeRun?.sessionId ?? null,
      scopeMode: this.deps.config.get().scopeMode,
      autonomous: this.autonomousMode,
    };
  }

  getHistoryView(): HistoryMessageView[] {
    return toHistoryView(this.history);
  }
}
