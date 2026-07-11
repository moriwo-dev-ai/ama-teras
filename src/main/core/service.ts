import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
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
  EvolutionScope,
  FilePreviewResult,
  HistoryMessageView,
  ModelPolicy,
  AutonomousRegistryScope,
  PluginErrorInfo,
  PluginImportStartResult,
  PluginManifest,
  ProviderId,
  ProvisionalInstall,
  SecretSlot,
  ReviewCardPayload,
  RunInfo,
  SessionLoadResult,
  SessionMeta,
  SubAgentUpdate,
  ToolExecResultPayload,
  ToolInfo,
  UsageDelta,
} from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { compactHistory, DEFAULT_COMPACTION_THRESHOLD, estimateTokens } from '../agent/compaction';
import { runAgentLoop } from '../agent/loop';
import { contextLimitFor, DEFAULT_MODELS, PROVIDER_PRESETS } from '../../shared/models';
// M27-1: freeMode の実効値制御(maxTurns/レビューゲート/ModelPolicy/進化無効)は config.ts の純関数が正本
import {
  effectiveMaxTurns,
  effectiveModelPolicy,
  effectiveReviewGate,
  evolutionDisabledReason,
} from '../config';
import { isModelUnavailableError, isRateLimitError, shortLLMError } from '../agent/llmErrors';
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
  composeUserPolicySection,
  readProjectMemory,
  readProjectPlan,
  readUserMemory,
} from '../memory';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from '../providers/anthropic';
import { DEFAULT_OPENAI_MODEL, OpenAIProvider } from '../providers/openai';
import type { ChatMessage, LLMProvider } from '../providers/types';
import { inspectImportDir } from '../registry/packager';
import {
  downloadRegistryPlugin,
  fetchRegistryIndex,
  matchRegistryEntries,
  type RegistryIndexEntry,
} from '../registry/search';
import { runReviewGateStep } from '../review/gateRunner';
import { newlyCompleted } from '../review/planDiff';
// M26-2: コア領域(聖域)判定はA側の正本リストを共用する(進化ジョブ非波及の逆方向importなのでOK)
import { isProtectedFile } from '../evolution/protected';
import {
  collectDeclaredPaths,
  executeToolWithApproval,
  type ExecutorDeps,
  type ScopeAuditEvent,
  type ScopePolicy,
} from '../tools/executor';
import type { ToolPlugin } from '../tools/types';
import { resolveBandLLM, type ModelBandName } from './bands';
import type { EventBus } from './events';
import { ProcessManager } from './processes';
import { previewFile, resolveRevealTarget, type RevealResolveResult } from './filePreview';
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
  enqueue(req: {
    description: string;
    expectedIO: string;
    /** M20: 省略=tool(従来) */
    scope?: EvolutionScope;
    /** M25-8: 既存ツールの修正対象(scope='tool'のみ意味を持つ) */
    targetTool?: string;
    /** M27-4: プラグインインポート元ディレクトリ(生成の代わりにコピーする) */
    importFrom?: string;
  }): Promise<number>;
  /** M26-6: ジョブのキャンセル(queued=キュー除去/実行中=abort)。未実装(セーフモード等)なら省略可 */
  cancel?(id: number): boolean;
  /** M29-5: 仮導入の棚卸し「削除」= evolve/N のマージrevert+ホットリロード */
  uninstallPromotion?(jobId: number): Promise<{ ok: boolean; message: string }>;
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
  secrets: { get(provider: SecretSlot): string | null };
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
  /** M28-3: レジストリ検索のHTTP実体(テスト用注入。既定 globalThis.fetch) */
  fetchFn?: typeof fetch;
  /**
   * M29-5: 仮導入(棚卸し待ち)の永続化。未応答のまま終了しても次回起動時に再提示するため
   * userData の JSON へ保存する(ipc.ts が注入。テストではメモリ実装)
   */
  provisionalStore?: { load(): ProvisionalInstall[]; save(items: ProvisionalInstall[]): void };
  /**
   * M29-5: 包括承認の範囲外候補に出す個別承認カードの応答タイムアウト(既定10分)。
   * タイムアウト=辞退扱いで従来の生成フローへ続行する(自律実行のハング防止)
   */
  individualApprovalTimeoutMs?: number;
  /**
   * M18 テスト用: 帯プロバイダ生成の差し替え。キー有無の判定(secrets)は差し替えの
   * 前に行われる(キー未登録の警告経路もテスト可能にするため)
   */
  bandProviderFactory?: (band: ModelBandName, provider: ProviderId, model: string) => LLMProvider;
  /**
   * M23-2: 使用量メーター(全LLM呼び出しの実測トークンを記録)。未指定なら計測しない。
   * M26-4: band(帯ラベル)付きで記録し、帯別のコスト可視化に使う
   */
  usage?: { record(provider: string, model: string, delta: UsageDelta, band?: string): void };
}

// M26-9(T9): 帯名と解決規則は bands.ts へ抽出(従来のimport元互換のため再export)
export type { ModelBandName } from './bands';

const SYSTEM_PROMPT = `あなたは AMA-teras — ユーザーのマシン上で動くコーディングエージェント。
与えられたツールを使ってファイルの調査・編集・コマンド実行を行い、ユーザーの指示を完遂する。

規範:
- 手を動かす前に不明点があれば read_file / list_dir / grep で自分で調べる
- 変更は最小限に。既存のコードスタイルに合わせる
- 破壊的な操作は慎重に。ツール実行はユーザー承認制の場合がある
- 複数ステップに及ぶ作業では、最初に plan ツールで計画(- [ ] 形式)を書き、
  項目が完了するたびに - [x] へ更新すること(計画は毎ターン注入され、長い作業でも失われない)
- 計画時は必ず能力ギャップを評価すること: 既存ツールの組み合わせで遠回りにこなす前に、
  「こういうツール/機能があれば効率よく・自動でできる」と判断したら request_capability で
  新ツールの獲得を積極的に提案する(名前案と期待入出力を具体的に)。同型作業の繰り返し・
  複雑なbashワンライナーの多用・形式変換などは専用ツール化の好機。進化はバックグラウンドで
  進むので、待つ間は既存ツールで進められる部分を先に進める。進化が失敗したら
  evolution_jobs で失敗ゲートとログを確認し、依頼内容を直して再申請する
- 今後も使う知見(ビルド方法・規約・ハマりどころ)を発見したら memory ツールで短く追記すること。
  会話固有の一時的な内容は記憶に書かないこと。ユーザーが「今後こうして」と恒久的な作業方針を
  教えてくれたら memory ツールの scope:"user" で保存すること(全プロジェクト共通で毎回注入される)
- ユーザーが体験する成果物(UI・Webページ・スクリプト・アプリ等)は、完了と報告する前に必ず
  ツールで実際に動かして確認すること — 画面は screenshot / http_screenshot で見た目を確認し、
  スクリプトは bash で実行し、サーバは起動してレスポンスを確かめる。「書けたはず」で完了としない
- 完了したら何をしたか簡潔に日本語で報告する`;

const PLAN_SUFFIX = `\n\n# プランモード\n今回は「計画のみ」を求められている。実装に入らず、
何をどの順で行うか(触るファイル・使うツール・確認事項)を簡潔な計画として提示せよ。
計画には能力ギャップの評価を含めること: 既存ツールで足りるか、新しいツール/機能があれば
効率よく・自動でできるか。後者なら「新ツール提案: 名前案・期待入出力・何が自動化されるか」を
計画に明記する(request_capability の実行は承認後)。
ツールは実行しない。ユーザーが計画を承認したら、次のメッセージで通常モードとして実行する。`;

/** M18: modelPolicy 有効時のみ system prompt に付ける分業ヒント(強制はしない) */
const POLICY_HINT = `\n\n# 分業ヒント(モデル自動切替 有効)
あなた(メイン会話)は高性能な planner 帯で動いている。実装の手数が多い工程
(複数ファイルの編集・テストの反復実行など)は dispatch_agent(mode:"work")へ委譲し、
あなたは計画・レビュー・統合・最終報告に集中すること。小さな作業は直接行ってよい。
調査・ファイル探索・コードの下読みは dispatch_agent(mode:"read")へ委譲する
(安価な explorer 帯が担当)。planner のあなたは大量のファイルを自分で読まないこと。`;

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

/** M22: 実行中ランの状態(会話ごとに高々1つ) */
interface RunState {
  sessionId: string;
  ac: AbortController;
  startedAt: number;
  /** ラン開始時に固定したworkspace(視聴切替でconfigが変わっても不変) */
  workspace: string;
  /** バックグラウンドプロセスも会話単位(他会話のcancelで殺さない) */
  processes: ProcessManager;
  /** M21-1: 追加指示キュー(ラン単位。終了で破棄) */
  pendingInstructions: { text: string; images?: ChatImageInput[] }[];
  lastStatus: AgentStatus;
  /** M23: このランが使っているモデル(provider/model。フォールバックで更新) */
  model: string;
}

/** M22: 会話ごとの独立状態(history・永続化・フォールバック・自律モード・ラン) */
interface ConvState {
  id: string;
  title: string;
  createdAt: string;
  /** M16-1: 最後にLLM呼び出しに使った provider+model(切替検知用) */
  lastLLM?: { provider: ProviderId; model: string };
  /** 履歴はランと参照共有(置換せず中身を差し替える) */
  history: ChatMessage[];
  /** M13-1: 直近APIコールの実測プロンプトトークン(compaction発火判定用) */
  lastPromptTokens: number;
  /** 保存の直列化は会話単位(同一ファイルへの並行書き込みを防ぐ=永続化の排他) */
  persistChain: Promise<void>;
  /** M16-2: フォールバックは1会話1回まで */
  fallbackUsed: boolean;
  /** M26-4: セーフガード拒否(refusal)からの復帰は billing とは別枠で1会話2回まで */
  refusalFallbackCount: number;
  /** M30-2: モデル未開放(404)からの安定版フォールバックは別枠で1会話1回まで */
  modelUnavailableFallbackUsed: boolean;
  /**
   * M17-2→M22: 自律モードを会話単位に。メモリ内のみ=アプリ再起動で必ずOFF。
   * 別会話への切替でこの会話のフラグは変わらない(実行中の自律ランは維持される)
   */
  autonomous: boolean;
  /**
   * M29-5: この自律実行の包括承認範囲(ON時に開始UIで選択。OFFで undefined)。
   * none=自動導入なし / verified=検証済み+危険権限なしのみ仮導入 /
   * verified-generate=上記+生成プラグインも仮導入
   */
  registryScope?: AutonomousRegistryScope;
  /**
   * M25-2: 進化結果による自動再開の回数(人間の送信でリセット)。
   * 進化失敗→自動再開→再申請→失敗…の無限連鎖でトークンを浪費しないための上限カウンター
   */
  autoResumeCount: number;
  /** 会話に束縛された作業ディレクトリ(送信/ロード時に更新) */
  workspace: string;
  run: RunState | null;
}

export class AgentService {
  readonly broker: ApprovalBroker;
  /** M11-2: バックグラウンドプロセス管理(手動ツール実行用。ラン中は run.processes を使う) */
  readonly processes = new ProcessManager();
  private readonly evolution: EvolutionLike;
  private readonly pendingApprovals = new Map<string, ApprovalRequestPayload>();
  private checkpointsCache: CheckpointsLike | null = null;
  private readonly pendingPromotions = new Map<number, (approved: boolean) => void>();
  private readonly pendingPromotionEvents = new Map<number, PromotionRequestEvent>();
  /** M22: ロード済み/実行中の会話。key=conversationId */
  private readonly conversations = new Map<string, ConvState>();
  /** いま表示している会話(chatSend/getStatus/getHistoryViewの対象) */
  private current: ConvState;
  /** M12-3: 子エージェントの連番(UI表示・承認ダイアログの出所表示用。全会話で一意) */
  private subAgentSeq = 0;

  /** 空の会話状態を作る(まだ conversations には登録しない=未使用の空会話を残さない) */
  private blankConv(): ConvState {
    return {
      id: randomUUID(),
      title: '',
      createdAt: new Date().toISOString(),
      history: [],
      lastPromptTokens: 0,
      persistChain: Promise.resolve(),
      fallbackUsed: false,
      refusalFallbackCount: 0,
      modelUnavailableFallbackUsed: false,
      autonomous: false,
      autoResumeCount: 0,
      workspace: '',
      run: null,
    };
  }

  /** M22: 実行中ラン一覧(左ペインの実行中表示・軟性しきい値・状態復元用) */
  runsList(): RunInfo[] {
    const runs: RunInfo[] = [];
    for (const conv of this.conversations.values()) {
      if (conv.run) {
        runs.push({
          conversationId: conv.id,
          title: conv.title || '(無題)',
          workspace: conv.run.workspace,
          sessionId: conv.run.sessionId,
          startedAt: conv.run.startedAt,
          model: conv.run.model,
        });
      }
    }
    return runs;
  }

  private publishRuns(): void {
    this.deps.bus.publish('runs:changed', this.runsList());
  }

  constructor(private readonly deps: AgentServiceDeps) {
    this.current = this.blankConv();
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
      // M20【不変条件3・ユーザー確定】→ M29-5(NIGHT_TASKS4 T5)でユーザー指示により契約更新:
      // 昇格承認は自律モード(autonomousMode)そのものでは絶対に自動化しない
      // (このブロックは autonomousMode / getAutonomous を参照しない — guardrailsテストで固定)。
      // 唯一の例外は「実行開始時に人間が明示した包括承認」による**仮導入**で、
      // 事前登録済みジョブ(provisionalCandidates)+scope='tool'+危険警告ゼロの全条件を
      // 満たす場合のみ自動承認し、終了後の棚卸しカードで人間が最終判断する(残す/削除)。
      // renderer / core の昇格はいかなる場合も人間のUI操作でのみ解決される
      requestPromotionApproval: (job, diff, warnings) => {
        const candidate = this.provisionalCandidates.get(job.id);
        if (candidate !== undefined) this.provisionalCandidates.delete(job.id);
        if (
          candidate !== undefined &&
          (job.scope ?? 'tool') === 'tool' &&
          warnings.length === 0 &&
          job.toolName !== undefined
        ) {
          this.recordProvisionalInstall(job.id, job.toolName, candidate.origin);
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          this.pendingPromotions.set(job.id, resolve);
          const event: PromotionRequestEvent = {
            kind: 'promotion_request',
            jobId: job.id,
            toolName: job.toolName ?? (job.scope !== undefined ? `(${job.scope}変更)` : '(不明)'),
            diff,
            warnings,
            ...(job.scope !== undefined ? { scope: job.scope } : {}),
            ...(job.requiresRestart !== undefined ? { requiresRestart: job.requiresRestart } : {}),
          };
          this.pendingPromotionEvents.set(job.id, event);
          deps.bus.publish('evolution:event', event);
        });
      },
      onEvent: (e) => {
        deps.bus.publish('evolution:event', e);
        this.trackProvisionalOutcome(e);
        this.notifyEvolutionToChat(e);
      },
    });
    this.provisionalInstalls = deps.provisionalStore?.load() ?? [];
  }

  // ---- M29-5: 仮導入(包括承認)と棚卸し ----

  /** 包括承認の範囲内として enqueue されたジョブ(昇格フックが自動承認してよい候補) */
  private readonly provisionalCandidates = new Map<number, { origin: 'registry' | 'generated' }>();
  /** 仮導入済み=棚卸し待ちの一覧(userDataへ永続化。未応答なら次回起動時に再提示) */
  private provisionalInstalls: ProvisionalInstall[] = [];

  private persistProvisional(): void {
    this.deps.provisionalStore?.save(this.provisionalInstalls);
  }

  private recordProvisionalInstall(jobId: number, toolName: string, origin: 'registry' | 'generated'): void {
    this.provisionalInstalls.push({
      jobId,
      toolName,
      origin,
      tag: `evolve/${jobId}`,
      installedAt: new Date().toISOString(),
    });
    this.persistProvisional();
    this.deps.audit.append({
      tool: 'provisional-install',
      scope: 'system',
      paths: [],
      event: 'result',
      detail: `仮導入(包括承認・棚卸し待ち): #${jobId} ${toolName} (${origin})`,
      autonomous: true,
    });
  }

  /** 仮導入したジョブが失敗/ロールバックしたら棚卸しリストから外す */
  private trackProvisionalOutcome(e: EvolutionEvent): void {
    if (e.kind !== 'job_update') return;
    if (e.job.status !== 'rolled_back' && e.job.status !== 'failed') return;
    const before = this.provisionalInstalls.length;
    this.provisionalInstalls = this.provisionalInstalls.filter((p) => p.jobId !== e.job.id);
    if (this.provisionalInstalls.length !== before) this.persistProvisional();
  }

  /** 棚卸し対象(仮導入済み)の一覧 */
  inventoryList(): ProvisionalInstall[] {
    return [...this.provisionalInstalls];
  }

  /**
   * 棚卸しの応答。keep=残す(仮マーク解除)/ keep=false=完全アンインストール
   * (evolve/N のマージrevert+ホットリロード)。失敗時はリストに残す
   */
  async inventoryResolve(jobId: number, keep: boolean): Promise<{ ok: boolean; message: string }> {
    const item = this.provisionalInstalls.find((p) => p.jobId === jobId);
    if (item === undefined) return { ok: false, message: `棚卸し対象 #${jobId} が見つからない` };
    if (keep) {
      this.provisionalInstalls = this.provisionalInstalls.filter((p) => p.jobId !== jobId);
      this.persistProvisional();
      this.deps.audit.append({
        tool: 'provisional-install',
        scope: 'system',
        paths: [],
        event: 'result',
        detail: `棚卸し: #${jobId} ${item.toolName} を残す(確定)`,
      });
      return { ok: true, message: `「${item.toolName}」を残しました` };
    }
    if (this.evolution.uninstallPromotion === undefined) {
      return { ok: false, message: 'この構成ではアンインストールできない(進化機能が無効)' };
    }
    const r = await this.evolution.uninstallPromotion(jobId);
    this.deps.audit.append({
      tool: 'provisional-install',
      scope: 'system',
      paths: [],
      event: 'result',
      detail: `棚卸し: #${jobId} ${item.toolName} を削除 → ${r.ok ? 'OK' : `失敗: ${r.message}`}`,
    });
    if (!r.ok) return r;
    this.provisionalInstalls = this.provisionalInstalls.filter((p) => p.jobId !== jobId);
    this.persistProvisional();
    return { ok: true, message: `「${item.toolName}」をアンインストールしました(${r.message})` };
  }

  /** 進化ジョブごとの通知済み状態(同じ状態のjob_updateが複数回来ても1回だけ通知) */
  private readonly evolutionNotified = new Map<number, string>();

  /**
   * M23-7: 進化の節目(承認待ち/完了/失敗/拒否/ロールバック)をチャットにも通知する。
   * conversationId を付けない=どの会話を見ていても表示される(remote-uiにも流れる)。
   * infoカードは履歴に保存されないため、詳細は従来どおり進化タブで確認する
   */
  private notifyEvolutionToChat(e: EvolutionEvent): void {
    if (e.kind !== 'job_update') return;
    const job = e.job;
    const NOTIFY: Record<string, (j: EvolutionJobSummary) => string> = {
      awaiting_promotion: (j) =>
        `🧬 進化ジョブ#${j.id} が検証ゲートを全て通過。昇格の承認待ちです(進化タブまたはダイアログで確認)`,
      done: (j) =>
        `🧬 進化ジョブ#${j.id} 完了${j.toolName ? `: 新ツール「${j.toolName}」が使えるようになりました` : ''}(詳細は進化タブ)`,
      failed: (j) => {
        const gate = (j.gates ?? []).find((g) => !g.ok);
        return `🧬 進化ジョブ#${j.id} 失敗${gate ? `(${gate.name}ゲート)` : ''}: ${(j.error ?? '原因不明').slice(0, 200)}(詳細は進化タブ)`;
      },
      rejected: (j) =>
        j.protectedReject === true
          ? `🧬 進化ジョブ#${j.id} は保護領域(聖域)に触れるため自動拒否されました(詳細は進化タブ)`
          : `🧬 進化ジョブ#${j.id} は却下されました`,
      rolled_back: (j) =>
        `🧬 進化ジョブ#${j.id} は昇格後の健全性チェックに失敗し、自動で巻き戻されました(詳細は進化タブ)`,
    };
    const build = NOTIFY[job.status];
    if (!build) return;
    if (this.evolutionNotified.get(job.id) === job.status) return;
    this.evolutionNotified.set(job.id, job.status);
    this.deps.bus.publish('chat:event', {
      kind: 'info',
      sessionId: `evolution-${job.id}`,
      message: build(job),
    });
    // M23-7: 依頼元の会話には「モデル自身への自動フィードバック」も入れる(人間向けinfoとは別)。
    // 実行中なら次のターン境界で注入(M21-1キュー)、待機中なら履歴へ積んで次の送信で読まれる
    if (job.status !== 'awaiting_promotion') this.feedEvolutionResultToModel(job);
  }

  /** M23-7: 進化の結果を依頼元会話のモデルへ伝える指示文を作って注入する */
  private feedEvolutionResultToModel(job: EvolutionJobSummary): void {
    if (job.originConversationId === undefined) return; // 手動起動(パネル/リモート)は人間が見ている
    const conv = this.conversations.get(job.originConversationId);
    if (!conv) return;
    let text: string;
    if (job.status === 'done') {
      text =
        `(自動通知)進化ジョブ#${job.id} が完了した。` +
        (job.toolName
          ? `新ツール「${job.toolName}」が動的ロード済みで、次のターンからツールとして使用できる。元のタスクの続きに活用せよ。`
          : '変更は昇格済み。元のタスクを続行せよ。');
    } else {
      const gate = (job.gates ?? []).find((g) => !g.ok);
      const detail =
        `(自動通知)進化ジョブ#${job.id}(${job.description.slice(0, 80)})は「${job.status}」で終わった。` +
        (gate ? `失敗ゲート: ${gate.name}。詳細: ${(gate.detail ?? '').slice(0, 300)}。` : '') +
        (job.error !== undefined ? `エラー: ${job.error.slice(0, 200)}。` : '');
      // M25-4: scope='tool'(新ツール欠如)は既存ツールでの代替が安全な回避策になるが、
      // scope='renderer'/'core' の失敗で「既存ツールでの代替」を提案すると、モデルが
      // edit_file/write_file で本体の生きたソースを直接・無検証で書き換えてしまう事故になる
      // (worktree隔離・検証ゲート・人間承認を全部バイパスする=進化パイプラインの意味が無くなる)。
      // renderer/core は代替提案をせず、再申請か人間への相談のみを促す
      text =
        job.scope === 'renderer' || job.scope === 'core'
          ? `${detail}これは自己修正(scope:${job.scope})の失敗である。直接 edit_file/write_file で本体のソースを書き換えて代替することは絶対にしてはならない` +
            '(worktree隔離・検証ゲート・人間承認を経ずに本体を変更することになるため)。' +
            '依頼内容(description/expected_io)を見直して request_capability を再申請するか、' +
            'それも難しければユーザーに状況を説明し、直接編集が必要か判断を仰げ。'
          : `${detail}この能力は当面使えない前提で、既存ツールでの代替手段を検討してタスクを続行するか、進化の依頼内容を修正して再申請せよ。`;
    }
    if (conv.run) {
      // 実行中: M21-1の追加指示キューへ(次のターン境界で履歴に注入される)
      conv.run.pendingInstructions.push({ text });
      this.deps.bus.publish('chat:event', {
        kind: 'instruction_queued',
        sessionId: conv.run.sessionId,
        text,
        conversationId: conv.id,
      });
      return;
    }
    // M25-2: 待機中は履歴に積むだけでなくランを自動再開する(「通知が来てもエージェントが
    // 動かない」対策)。人間が却下した rejected は再開しない(却下の意思を尊重+再申請ループ防止)。
    // 自動再開はユーザー送信なしで最大3連鎖まで(失敗→再申請→失敗…の暴走防止)
    const canAutoResume = job.status !== 'rejected' && conv.autoResumeCount < 3;
    if (canAutoResume) {
      conv.autoResumeCount += 1;
      this.deps.bus.publish('chat:event', {
        kind: 'info',
        sessionId: `evolution-${job.id}`,
        message: `🧬 進化ジョブ#${job.id} の結果を受けて、依頼元の会話を自動再開します(${conv.autoResumeCount}/3)`,
        conversationId: conv.id,
      });
      this.chatSend(text, 'normal', undefined, conv);
      return;
    }
    // 再開しない場合(rejected / 上限到達): 履歴へ積んで次のユーザー送信で読まれる
    const last = conv.history[conv.history.length - 1];
    if (last && last.role === 'user') last.content.push({ type: 'text', text });
    else conv.history.push({ role: 'user', content: [{ type: 'text', text }] });
    this.persistSession(conv);
    this.deps.bus.publish('chat:event', {
      kind: 'instruction_queued',
      sessionId: `evolution-${job.id}`,
      text,
      conversationId: conv.id,
    });
    if (job.status !== 'rejected') {
      this.deps.bus.publish('chat:event', {
        kind: 'info',
        sessionId: `evolution-${job.id}`,
        message: `🧬 自動再開の上限(3回)に達したため停止中。続きはメッセージを送ると再開されます`,
        conversationId: conv.id,
      });
    }
  }

  // ---- provider ----

  /**
   * M26-4: セーフガード拒否(refusal)時の「同一プロバイダの1段下モデル」候補。
   * 前方一致で照合し、段下が無い(最下段等)場合は設定済みフォールバック先へ委ねる
   */
  private refusalFallbackLLM(current: {
    provider: ProviderId;
    model: string;
  }): { provider: ProviderId; model: string } | null {
    const DOWNGRADES: { provider: ProviderId; prefix: string; model: string }[] = [
      { provider: 'anthropic', prefix: 'claude-fable-5', model: 'claude-opus-4-8' },
      { provider: 'anthropic', prefix: 'claude-opus', model: 'claude-sonnet-5' },
      { provider: 'anthropic', prefix: 'claude-sonnet', model: 'claude-haiku-4-5' },
      // M30-1: GPT-5.6 世代の段下(Sol→Terra→Luna)。luna・エイリアス素の 'gpt-5.6' は
      // 段下なし=設定済みフォールバックへ(prefix 'gpt-5.6' を置くと luna が terra へ
      // 「格上げ」されてしまうため意図的に置かない)
      { provider: 'openai', prefix: 'gpt-5.6-sol', model: 'gpt-5.6-terra' },
      { provider: 'openai', prefix: 'gpt-5.6-terra', model: 'gpt-5.6-luna' },
      { provider: 'openai', prefix: 'gpt-5.5', model: 'gpt-5.4' },
    ];
    const down = DOWNGRADES.find(
      (d) => d.provider === current.provider && current.model.startsWith(d.prefix) && d.model !== current.model,
    );
    if (down) return { provider: down.provider, model: down.model };
    // 段下が定義できないモデル: 設定済みフォールバック先(有効時)を使う
    const fb = this.deps.config.get().fallback;
    if (!fb || fb.enabled !== true) return null;
    const fbModel = fb.model.trim() !== '' ? fb.model : DEFAULT_MODELS[fb.provider];
    if (fb.provider === current.provider && fbModel === current.model) return null;
    return { provider: fb.provider, model: fbModel };
  }

  /**
   * M30-2: モデル未開放(404)時の「同一プロバイダの既知の安定モデル」候補。
   * 新モデルはGA後もアカウント単位で段階開放のため、未開放環境では前世代の安定版へ
   * 自動フォールバックして続行する(gpt-5.6系 → gpt-5.5)。
   * 対象外(安定版が定義できない・既に安定版)は null=フォールバックせずエラー表示
   */
  private stableFallbackLLM(current: {
    provider: ProviderId;
    model: string;
  }): { provider: ProviderId; model: string } | null {
    const STABLE: { provider: ProviderId; prefix: string; model: string }[] = [
      // エイリアス素の 'gpt-5.6' も含め gpt-5.6* は全て前世代フラッグシップへ
      { provider: 'openai', prefix: 'gpt-5.6', model: 'gpt-5.5' },
    ];
    const hit = STABLE.find(
      (d) => d.provider === current.provider && current.model.startsWith(d.prefix) && d.model !== current.model,
    );
    return hit ? { provider: hit.provider, model: hit.model } : null;
  }

  /**
   * M23-2: プロバイダを使用量計測つきでラップする。message_done の実測usageを
   * UsageMeter へ記録するだけで、ストリームは素通し(挙動不変)。未注入なら素のまま。
   * M26-4: band ラベル(planner/worker/reviewer/explorer/escalation等)を付けて帯別集計する
   */
  private track(provider: LLMProvider, providerId: string, model: string, band?: string): LLMProvider {
    const usage = this.deps.usage;
    if (!usage) return provider;
    return {
      id: provider.id,
      complete: (req) => {
        const inner = provider.complete(req);
        return (async function* () {
          for await (const ev of inner) {
            if (ev.type === 'message_done') {
              usage.record(
                providerId,
                model,
                {
                  inputTokens: ev.usage.inputTokens,
                  outputTokens: ev.usage.outputTokens,
                  cacheReadTokens: ev.usage.cacheReadTokens,
                },
                band,
              );
            }
            yield ev;
          }
        })();
      },
    };
  }

  createProvider(): LLMProvider | string {
    if (this.deps.providerFactory) return this.deps.providerFactory();
    const cfg = this.deps.config.get();
    if (cfg.provider === 'openai') {
      // M27-1: プリセット(無料APIモード)= OpenAI互換エンドポイント+専用キースロット
      const preset = cfg.providerPreset !== undefined ? PROVIDER_PRESETS[cfg.providerPreset] : undefined;
      if (preset !== undefined) {
        const key = this.deps.secrets.get(preset.id);
        if (!key) return `${preset.label.split('(')[0]} のAPIキーが未設定(設定画面の「無料で始める」から登録)`;
        const model = cfg.model || preset.defaultModel;
        return this.track(new OpenAIProvider(key, model, preset.baseUrl), 'openai', model, 'main');
      }
      const key = this.deps.secrets.get('openai');
      if (!key) return 'OpenAI APIキーが未設定(設定画面から登録)';
      const model = cfg.model || DEFAULT_OPENAI_MODEL;
      return this.track(new OpenAIProvider(key, model), 'openai', model, 'main');
    }
    const key = this.deps.secrets.get('anthropic');
    if (!key) return 'Anthropic APIキーが未設定(設定画面から登録)';
    const model = cfg.model || DEFAULT_ANTHROPIC_MODEL;
    return this.track(new AnthropicProvider(key, model), 'anthropic', model, 'main');
  }

  // ---- M18: モデル自動切替(役割ベース割当) ----

  /**
   * 有効な modelPolicy(enabled=true)。無効・未設定なら null(=従来の単一モデル挙動)。
   * M27-1: freeMode 中は常に null(帯別モデルは有料キー前提の機構のため)
   */
  private modelPolicy(): ModelPolicy | null {
    const p = effectiveModelPolicy(this.deps.config.get());
    return p !== undefined && p.enabled ? p : null;
  }

  /** 帯の実効 provider+model(解決規則は bands.ts の resolveBandLLM が正本)。policy 無効なら null */
  private bandLLM(band: ModelBandName): { provider: ProviderId; model: string } | null {
    return resolveBandLLM(this.modelPolicy(), band);
  }

  /**
   * M26-2: 書き込みツールの宣言パス(pathParams)がコア領域(聖域=PROTECTED_PATHS)に
   * 触れるか。触れたランのレビューは reviewer 帯ではなく planner 帯で実施する。
   * bash等のパス無宣言ツールは検知対象外(既知の限界。exec経由のコア変更は捕捉できない)
   */
  private touchedCoreArea(toolName: string, input: unknown, workspace: string): boolean {
    const plugin = this.deps.registry.get(toolName);
    if (!plugin) return false;
    for (const abs of collectDeclaredPaths(plugin, input, workspace)) {
      const rel = relative(workspace, abs).replaceAll('\\', '/');
      if (rel !== '' && !rel.startsWith('..') && isProtectedFile(rel) !== null) return true;
    }
    return false;
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
    return this.track(
      llm.provider === 'openai' ? new OpenAIProvider(key, llm.model) : new AnthropicProvider(key, llm.model),
      llm.provider,
      llm.model,
      band,
    );
  }

  /** 進化ジョブ(AgentJobRunner)用。キー未設定は例外にする */
  createProviderOrThrow(): LLMProvider {
    const provider = this.createProvider();
    if (typeof provider === 'string') throw new Error(provider);
    return provider;
  }

  /** M32: 運営機能(週報・発信ドラフト・トリアージ)用のLLM帯。string=キー未設定メッセージ */
  operationsBandProvider(band: 'planner' | 'reviewer'): LLMProvider | string {
    return this.createBandProvider(band);
  }

  // ---- workspace / executor ----

  getWorkspace(): string {
    const ws = this.deps.config.get().workspace;
    return ws && ws.trim() !== '' ? ws : this.deps.defaultWorkspace();
  }

  private getScopePolicy(workspace?: string): ScopePolicy {
    return {
      mode: this.deps.config.get().scopeMode,
      workspaceRoot: workspace ?? this.getWorkspace(),
      deny: this.deps.denyPaths,
    };
  }

  /**
   * M22: ラン束縛つき executor 依存。binding 指定時は workspace(スコープ・フックcwd)・
   * 自律モード(会話単位)・承認origin(出所表示)がその会話/ランに固定される。
   * 未指定(手動実行)は現在の会話+現在のworkspace
   */
  private executorDeps(binding?: { workspace: string; conv: ConvState }): ExecutorDeps {
    const ws = (): string => binding?.workspace ?? this.getWorkspace();
    const conv = (): ConvState => binding?.conv ?? this.current;
    return {
      registry: this.deps.registry,
      broker: this.broker,
      getAutoApprove: () => this.deps.config.get().autoApprove,
      getScopePolicy: () => this.getScopePolicy(ws()),
      audit: (e) => this.deps.audit.append(e),
      // M11-4: 編集後フック。fullPc でも cwd は workspace に固定する
      getPostEditHook: () => {
        const cmd = this.deps.config.get().postEditHook;
        return cmd !== undefined && cmd.trim() !== '' ? { command: cmd, cwd: ws() } : null;
      },
      // M14-5: fullPc の「セッション中許可(このフォルダ)」(既定OFF=M9どおり毎回承認)
      getFullPcAllowSession: () => this.deps.config.get().fullPcAllowSession === true,
      // M17-2→M22: 自律モードは会話単位。進化ジョブは executorDeps() を経由しないため波及しない
      getAutonomous: () => conv().autonomous,
      // M22: 承認要求の出所(どの会話/プロジェクトからか)
      getOrigin: () =>
        binding !== undefined
          ? { conversationId: binding.conv.id, title: binding.conv.title || '(無題)', workspace: binding.workspace }
          : null,
    };
  }

  // ---- 自律モード(M17-2、M22で会話単位に) ----

  getAutonomous(): boolean {
    return this.current.autonomous;
  }

  /** ON/OFF の切替(現在の会話に対して)。全切替を監査に記録し、全画面へ通知する */
  setAutonomous(on: boolean, registryScope?: AutonomousRegistryScope): { on: boolean } {
    // M29-5: ONのたびに包括承認範囲を確定する(未指定は設定の既定値、それも無ければ none)
    const scope: AutonomousRegistryScope = on
      ? (registryScope ?? this.deps.config.get().autonomousRegistryScope ?? 'none')
      : 'none';
    if (this.current.autonomous === on && (this.current.registryScope ?? 'none') === scope) {
      return { on };
    }
    this.current.autonomous = on;
    if (on) this.current.registryScope = scope;
    else delete this.current.registryScope;
    this.deps.audit.append({
      tool: 'autonomous-mode',
      scope: 'system',
      paths: [],
      event: 'result',
      detail: on ? `on(registry: ${scope})` : 'off',
      autonomous: true,
    });
    this.deps.bus.publish('autonomous:changed', { on, ...(on ? { registryScope: scope } : {}) });
    return { on };
  }

  /** workspace 変更に追従してチェックポイント管理を作り直す(未設定なら null = 無効) */
  private getCheckpoints(workspace?: string): CheckpointsLike | null {
    const factory = this.deps.createCheckpoints;
    if (!factory) return null;
    const ws = workspace ?? this.getWorkspace();
    if (!this.checkpointsCache || this.checkpointsCache.workspace !== ws) {
      this.checkpointsCache = factory(ws);
    }
    return this.checkpointsCache;
  }

  private evolutionContext(origin?: ConvState) {
    return {
      requestCapability: async (
        description: string,
        expectedIO: string,
        scope?: EvolutionScope,
        targetTool?: string,
      ) => {
        const jobId = await this.evolution.enqueue({
          description,
          expectedIO,
          ...(scope !== undefined ? { scope } : {}),
          ...(targetTool !== undefined ? { targetTool } : {}),
          // M23-7: 結果をモデルへ自動フィードバックする宛先(依頼元の会話)
          ...(origin !== undefined ? { originConversationId: origin.id } : {}),
        });
        // M29-5: 包括承認 verified-generate の自律実行では、生成ツール(scope=tool)の
        // 昇格を仮導入として自動承認してよい候補に登録する(危険警告があれば昇格フックが弾く)
        if (
          origin?.autonomous === true &&
          origin.registryScope === 'verified-generate' &&
          (scope ?? 'tool') === 'tool'
        ) {
          this.provisionalCandidates.set(jobId, { origin: 'generated' });
        }
        return { jobId };
      },
      // M24: evolution_jobs ツールがパイプラインの内部ログを読むための入口
      list: () => this.evolution.list(),
      // M28-3: 「作る前に探す」(request_capability が生成の前に呼ぶ)
      searchRegistryAndImport: (description: string, expectedIO: string, signal: AbortSignal) =>
        this.searchRegistryAndImport(description, expectedIO, signal, origin),
    };
  }

  /**
   * M28-3: レジストリ検索 → 候補カード(承認ダイアログ)→ ダウンロード →
   * M27-4 のインポートパイプライン(B環境検証→承認→導入)へ接続する。
   * レジストリ未設定・ネット不達・マッチなしは 'none'(静かに生成へフォールバック)。
   * 自律モード中は承諾カードを見る人間がいないため検索をスキップする(安全側)
   */
  private async searchRegistryAndImport(
    description: string,
    expectedIO: string,
    signal: AbortSignal,
    origin?: ConvState,
  ): Promise<
    | { outcome: 'imported'; jobId: number; name: string }
    | { outcome: 'declined'; name: string }
    | { outcome: 'none' }
  > {
    const registryUrl = this.deps.config.get().registryUrl;
    // M29-4: 空文字=明示的な検索無効(既定は公式レジストリURL)
    if (registryUrl === undefined || registryUrl === '') return { outcome: 'none' };
    const autonomous = origin?.autonomous === true;
    const runScope: AutonomousRegistryScope = origin?.registryScope ?? 'none';
    // M29-5: 自律モードで包括承認 none は現行どおり検索スキップ(生成へ直行)
    if (autonomous && runScope === 'none') return { outcome: 'none' };
    const fetchFn = this.deps.fetchFn ?? fetch;
    const entries = await fetchRegistryIndex(registryUrl, fetchFn);
    if (entries === null || entries.length === 0) return { outcome: 'none' };
    const matches = matchRegistryEntries(entries, `${description} ${expectedIO}`);
    const best = matches[0]?.entry;
    if (best === undefined) return { outcome: 'none' };

    const others = matches
      .slice(1, 3)
      .map((m) => `- ${m.entry.name}@${m.entry.version}: ${m.entry.description.slice(0, 80)}`)
      .join('\n');
    const candidateCard = (extraWarnings: string[]): Omit<ApprovalRequestPayload, 'id'> => ({
      toolName: 'registry-search',
      risk: 'safe',
      inputPreview:
        `候補: ${best.name}@${best.version}\n説明: ${best.description}\n` +
        `作者: ${best.author || '不明'} / ${best.verified ? '✅ 検証済み(レジストリCI+人間承認)' : '⚠ 未検証'}` +
        (others !== '' ? `\n\n他の候補:\n${others}` : ''),
      warnings: [
        `コミュニティに既存の進化があります。「許可」でダウンロードして検証ゲート(B環境: typecheck→テスト→スモーク)へ進みます(導入前に必ず昇格承認があります)。「拒否」で従来どおり新規生成します`,
        ...(best.verified ? [] : ['この候補は未検証です(レジストリの人間承認を通っていません)']),
        ...extraWarnings,
      ],
    });

    if (!autonomous) {
      // 対話モード: 従来どおり承諾カード → ダウンロード → インポート(昇格は人間承認)
      const decision = await this.broker.request(candidateCard([]), signal);
      if (decision === 'deny') return { outcome: 'declined', name: best.name };
      return this.downloadAndStartImport(registryUrl, best, fetchFn, origin);
    }

    // M29-5: 自律モード(包括承認 verified / verified-generate)。
    // 危険権限は manifest を見ないと判定できないため、先にダウンロード+検査する
    const dl = await this.downloadCandidate(registryUrl, best, fetchFn, origin);
    if (dl === null) return { outcome: 'none' };
    const perms = dl.manifest.permissions;
    const dangerous = perms.network || perms.childProcess;
    if (best.verified && !dangerous) {
      // 包括承認の範囲内 → 無人で検証ゲートへ。昇格は仮導入として自動承認され、終了後に棚卸し
      const started = await this.pluginImportStart(dl.dir);
      if (!started.ok || started.jobId === undefined) {
        this.emitInfoTo(origin, `レジストリ候補「${best.name}」の検査に失敗: ${started.message} — 従来の生成フローへ進みます`);
        return { outcome: 'none' };
      }
      this.provisionalCandidates.set(started.jobId, { origin: 'registry' });
      this.emitInfoTo(
        origin,
        `📦 包括承認(${runScope})によりコミュニティプラグイン「${best.name}」を仮導入します(B環境検証3段の通過後に有効化。作業終了時の棚卸しで残す/削除を確認します)`,
      );
      return { outcome: 'imported', jobId: started.jobId, name: best.name };
    }

    // 範囲外(未検証 or 危険権限)→ 個別承認カードで一時停止。タイムアウトで生成へ続行
    const timeoutMs = this.deps.individualApprovalTimeoutMs ?? 600_000;
    const reason = dangerous
      ? `⚠ この候補は危険権限(network=${perms.network} / childProcess=${perms.childProcess})を宣言しており、包括承認の範囲外です`
      : '⚠ この候補は未検証のため、包括承認の範囲外です';
    const decision = await this.broker.request(
      candidateCard([reason, `${Math.round(timeoutMs / 60_000)}分以内に応答がなければ辞退して新規生成に進みます`]),
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    );
    if (decision === 'deny') return { outcome: 'declined', name: best.name };
    // 個別承認あり → 通常インポート(仮導入ではない=昇格は従来どおり人間承認)
    const started = await this.pluginImportStart(dl.dir);
    if (!started.ok || started.jobId === undefined) {
      this.emitInfoTo(origin, `レジストリ候補「${best.name}」の検査に失敗: ${started.message} — 従来の生成フローへ進みます`);
      return { outcome: 'none' };
    }
    return { outcome: 'imported', jobId: started.jobId, name: best.name };
  }

  /** 候補一式をダウンロードして検査まで行う。失敗は情報カード+null(生成へフォールバック) */
  private async downloadCandidate(
    registryUrl: string,
    entry: RegistryIndexEntry,
    fetchFn: typeof fetch,
    origin?: ConvState,
  ): Promise<{ dir: string; manifest: PluginManifest } | null> {
    const destDir = join(tmpdir(), `amateras-registry-${randomUUID()}`, entry.name);
    const dl = await downloadRegistryPlugin(registryUrl, entry, destDir, fetchFn);
    if (!dl.ok) {
      this.emitInfoTo(origin, `レジストリ候補「${entry.name}」の${dl.message} — 従来の生成フローへ進みます`);
      return null;
    }
    const inspection = await inspectImportDir(destDir);
    if (!inspection.ok || inspection.manifest === undefined) {
      this.emitInfoTo(
        origin,
        `レジストリ候補「${entry.name}」の検査に失敗: ${inspection.errors.join(' / ')} — 従来の生成フローへ進みます`,
      );
      return null;
    }
    return { dir: destDir, manifest: inspection.manifest };
  }

  /** 対話モード用: ダウンロード→インポート開始(旧フローの共通化) */
  private async downloadAndStartImport(
    registryUrl: string,
    entry: RegistryIndexEntry,
    fetchFn: typeof fetch,
    origin?: ConvState,
  ): Promise<{ outcome: 'imported'; jobId: number; name: string } | { outcome: 'none' }> {
    const dl = await this.downloadCandidate(registryUrl, entry, fetchFn, origin);
    if (dl === null) return { outcome: 'none' };
    const started = await this.pluginImportStart(dl.dir);
    if (!started.ok || started.jobId === undefined) {
      this.emitInfoTo(origin, `レジストリ候補「${entry.name}」の検査に失敗: ${started.message} — 従来の生成フローへ進みます`);
      return { outcome: 'none' };
    }
    return { outcome: 'imported', jobId: started.jobId, name: entry.name };
  }

  /** 依頼元会話へ情報カードを流す(会話が無ければ捨てる) */
  private emitInfoTo(origin: ConvState | undefined, message: string): void {
    const run = origin?.run;
    if (run == null) return;
    this.deps.bus.publish('chat:event', {
      kind: 'info',
      sessionId: run.sessionId,
      message,
      conversationId: origin!.id,
    });
  }

  /** M27-1: freeMode 中は request_capability の新規生成を止める(ToolContext へ理由を注入) */
  private evolutionDisabledCtx(): { evolutionDisabled: string } | Record<string, never> {
    const reason = evolutionDisabledReason(this.deps.config.get());
    return reason !== null ? { evolutionDisabled: reason } : {};
  }

  /**
   * M27-1: 停止時LLMエラーの平易化。無料APIモード(プリセット使用中)の429を
   * プリセット別の案内文へ差し替える。
   * M30-2: モデル未開放(404)は段階開放の説明+設定への導線(settingsHint)を付ける。
   * それ以外は null(=生のエラー表示)
   */
  private friendlyLLMError(
    err: unknown,
  ): string | { message: string; settingsHint: 'models' | 'basic' } | null {
    // M30-2: モデル未開放/不存在(フォールバック不発でここへ来たケース)
    if (isModelUnavailableError(err)) {
      const policyOn = this.modelPolicy() !== null;
      const llm = this.currentLLM();
      return {
        message:
          `モデル「${llm.model}」はあなたのアカウントにまだ開放されていない可能性があります` +
          `(新モデルはGA後も段階開放されます)。設定→「${policyOn ? 'モデル運用' : '基本'}」タブで` +
          `利用可能なモデル(例: gpt-5.5)へ切り替えてください。開放され次第、元の設定で使えます。` +
          `(元エラー: ${shortLLMError(err)})`,
        settingsHint: policyOn ? 'models' : 'basic',
      };
    }
    const cfg = this.deps.config.get();
    if (cfg.freeMode !== true || cfg.provider !== 'openai' || cfg.providerPreset === undefined) return null;
    if (!isRateLimitError(err)) return null;
    return `${PROVIDER_PRESETS[cfg.providerPreset].rateLimitNotice}(元エラー: ${shortLLMError(err)})`;
  }

  /**
   * M29-1: 接続テストが実際に叩くエンドポイント(診断表示用)。
   * OpenAI SDK は baseURL に "/chat/completions" を連結する(末尾スラッシュは
   * プロバイダ側で正規化済み)
   */
  private connectionEndpoint(): string {
    const cfg = this.deps.config.get();
    if (cfg.provider === 'openai') {
      const preset = cfg.providerPreset !== undefined ? PROVIDER_PRESETS[cfg.providerPreset] : undefined;
      const base = (preset?.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
      return `${base}/chat/completions`;
    }
    return 'https://api.anthropic.com/v1/messages';
  }

  /**
   * M27-1: 接続テスト(設定画面用)。現在の設定でプロバイダを生成し、
   * 最小の1リクエスト(数トークン)を送って成否を返す。30秒でタイムアウト
   */
  async connectionTest(): Promise<{ ok: boolean; message: string }> {
    const provider = this.createProvider();
    if (typeof provider === 'string') return { ok: false, message: provider };
    const llm = this.currentLLM();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30_000);
    try {
      let gotDone = false;
      for await (const ev of provider.complete({
        system: '接続テスト。「OK」とだけ返答せよ。',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }],
        tools: [],
        maxTokens: 16,
        signal: ac.signal,
      })) {
        if (ev.type === 'message_done') gotDone = true;
      }
      if (!gotDone) return { ok: false, message: '応答が完了しなかった(message_doneなし)' };
      return { ok: true, message: `接続OK(${llm.provider}/${llm.model})` };
    } catch (err) {
      if (ac.signal.aborted) return { ok: false, message: '接続テストがタイムアウトした(30秒)' };
      // M29-1: 診断力強化 — 実際に叩いたURL・HTTPステータス・レスポンスbody(あれば)を出す
      const rec = typeof err === 'object' && err !== null ? (err as Record<string, unknown>) : {};
      const status = typeof rec['status'] === 'number' ? rec['status'] : undefined;
      const body =
        rec['error'] !== undefined ? JSON.stringify(rec['error']).slice(0, 300) : undefined;
      return {
        ok: false,
        message:
          `接続失敗: ${shortLLMError(err)}\n` +
          `診断: URL=${this.connectionEndpoint()} / model=${llm.model}` +
          (status !== undefined ? ` / HTTP ${status}` : '') +
          (body !== undefined ? `\nレスポンスbody: ${body}` : ''),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- chat ----

  /**
   * M16-1: 現在のメイン会話が使う provider+model(切替検知・lastLLM 記録用)。
   * M18: modelPolicy 有効時は planner 帯(=メイン会話の実体)を指す
   */
  private currentLLM(): { provider: ProviderId; model: string } {
    const planner = this.bandLLM('planner');
    if (planner) return planner;
    const cfg = this.deps.config.get();
    // M27-1: プリセット使用中の既定モデルはプリセット側の既定
    const fallbackModel =
      cfg.provider === 'openai' && cfg.providerPreset !== undefined
        ? PROVIDER_PRESETS[cfg.providerPreset].defaultModel
        : DEFAULT_MODELS[cfg.provider];
    return { provider: cfg.provider, model: cfg.model || fallbackModel };
  }

  /**
   * M16-1: プロバイダ/モデル切替の検知。切替時は prompt cache が無効になり長い履歴の
   * 再送が高くつくため、閾値(既定24k)超なら初回LLM呼び出しの前に圧縮しておく。
   * 戻り値は情報カードに出すメッセージ(切替なしなら null)
   */
  private async compactOnSwitch(conv: ConvState, provider: LLMProvider, signal: AbortSignal): Promise<string | null> {
    const current = this.currentLLM();
    const prev = conv.lastLLM;
    conv.lastLLM = current;
    if (!prev || (prev.provider === current.provider && prev.model === current.model)) return null;
    // 実測が古い(切替直後・ロード直後)可能性があるため推定との大きい方で判定する
    const measured = Math.max(conv.lastPromptTokens, estimateTokens(conv.history));
    const compacted = await this.maybeCompact(conv, provider, signal, {
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
    conv: ConvState,
    provider: LLMProvider,
    signal: AbortSignal,
    override?: { thresholdTokens: number; measuredTokens: number },
  ): Promise<boolean> {
    // M18: policy有効時のメイン会話は planner 帯のモデル上限で判定する(currentLLMが吸収)
    const threshold =
      override?.thresholdTokens ?? Math.floor(contextLimitFor(this.currentLLM().model) * 0.7);
    const ws = conv.run?.workspace ?? this.getWorkspace();
    const compacted = await compactHistory(provider, conv.history, {
      signal,
      measuredTokens: override?.measuredTokens ?? conv.lastPromptTokens,
      thresholdTokens: threshold,
      onMemoryEscape: (text) => {
        try {
          appendLearnedMemory(ws, text);
        } catch (err) {
          console.error('[memory] 退避失敗:', err instanceof Error ? err.message : err);
        }
      },
    });
    if (compacted) conv.lastPromptTokens = 0;
    return compacted;
  }

  // ---- セッション永続化(M12-1) ----

  /**
   * 現在の会話を userData/sessions へ保存する(fire-and-forget・直列化)。
   * 履歴JSONが上限超過なら provider で畳んでから保存。保存失敗でチャットは止めない。
   */
  private persistSession(conv: ConvState, provider?: LLMProvider): void {
    const store = this.deps.sessions;
    if (!store || conv.title === '') return; // 未使用の空会話は保存しない
    // M22: 保存の直列化は会話単位(同一ファイルの排他)。別会話の保存はブロックしない
    conv.persistChain = conv.persistChain.then(async () => {
      try {
        if (provider) await foldHistoryIfOversize(provider, conv.history);
        const data: SessionData = {
          version: SESSION_SCHEMA_VERSION,
          id: conv.id,
          title: conv.title,
          workspace: conv.workspace || this.getWorkspace(),
          createdAt: conv.createdAt,
          updatedAt: new Date().toISOString(),
          history: conv.history,
          ...(conv.lastLLM !== undefined ? { lastLLM: conv.lastLLM } : {}),
        };
        await store.save(data);
      } catch (err) {
        console.error('[sessions] 保存失敗:', err instanceof Error ? err.message : err);
      }
    });
  }

  /**
   * M26-7: 現在表示中の会話の workspace を明示的に移動する(evolve/8 残課題)。
   * 実行中(conv.run あり)は不可。移動後は以降のラン(ツール実行・チェックポイント・
   * 計画/記憶の読取)が新 workspace を参照する。scopeMode='project' のスコープ境界も
   * 次のランから新 workspace 基準になる(実行中ランの束縛は変えない設計のため実行中は拒否)。
   * グローバル設定(config.workspace)も追従させる(左ペインの会話切替=sessionOpen と同じ規則。
   * EnvWidget 表示・新規会話の既定と食い違わないようにする)
   */
  conversationMoveWorkspace(newWorkspace: string): { ok: boolean; message: string } {
    const conv = this.current;
    if (conv.run !== null) {
      return { ok: false, message: '実行中の会話は移動できない(停止または完了後に実行すること)' };
    }
    const target = newWorkspace.trim();
    if (target === '' || !isAbsolute(target)) {
      return { ok: false, message: '移動先は絶対パスで指定すること' };
    }
    try {
      if (!statSync(target).isDirectory()) {
        return { ok: false, message: '移動先がディレクトリではない' };
      }
    } catch {
      return { ok: false, message: '移動先ディレクトリが存在しない' };
    }
    const prev = conv.workspace !== '' ? conv.workspace : this.getWorkspace();
    if (prev === target) return { ok: false, message: '既に同じ workspace で作業している' };
    conv.workspace = target;
    // グローバル設定へ追従(sessionOpen と同じ規則)
    const cfg = this.deps.config.get();
    if (this.deps.config.set && target !== (cfg.workspace ?? '')) {
      this.deps.config.set({ ...cfg, workspace: target });
    }
    this.persistSession(conv);
    this.deps.bus.publish('chat:event', {
      kind: 'info',
      sessionId: 'workspace-move',
      message: `📁 この会話の作業ディレクトリを移動した: ${prev} → ${target}(以降のツール実行はこちらを参照)`,
      conversationId: conv.id,
    });
    return { ok: true, message: `${prev} → ${target}` };
  }

  async sessionsList(): Promise<SessionMeta[]> {
    return (await this.deps.sessions?.list()) ?? [];
  }

  async sessionLoad(id: string): Promise<SessionLoadResult> {
    // M22: 実行中でも切替可(ランには触らない)。実行中の会話を開くと生きたhistoryに接続する
    const live = this.conversations.get(id);
    if (live) return this.attachConversation(live);
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
   */
  async sessionOpen(id: string): Promise<SessionLoadResult> {
    const live = this.conversations.get(id);
    const ws = live?.workspace ?? (await this.deps.sessions?.load(id))?.workspace;
    const cfg = this.deps.config.get();
    if (ws !== undefined && ws !== '' && ws !== (cfg.workspace ?? '') && this.deps.config.set) {
      this.deps.config.set({ ...cfg, workspace: ws });
    }
    return this.sessionLoad(id);
  }

  /** M22: ロード済み(または実行中)の会話へ表示を切り替える */
  private attachConversation(conv: ConvState): SessionLoadResult {
    this.current = conv;
    return {
      ok: true,
      history: toHistoryView(conv.history),
      conversationId: conv.id,
      autonomous: conv.autonomous,
      ...(conv.run !== null
        ? { running: { sessionId: conv.run.sessionId, startedAt: conv.run.startedAt } }
        : {}),
    };
  }

  private applyLoadedSession(data: SessionData): SessionLoadResult {
    const conv: ConvState = {
      id: data.id,
      title: data.title,
      createdAt: data.createdAt,
      ...(data.lastLLM !== undefined ? { lastLLM: data.lastLLM } : {}),
      history: [...data.history],
      // 実測値は次のAPIコールまで無いので推定で近似(M13-1)
      lastPromptTokens: estimateTokens(data.history),
      persistChain: Promise.resolve(),
      fallbackUsed: false,
      refusalFallbackCount: 0,
      modelUnavailableFallbackUsed: false,
      // M17-2: ディスクから開いた会話の自律モードは必ずOFF(会話単位・再起動/開き直しでOFF)
      autonomous: false,
      autoResumeCount: 0,
      workspace: data.workspace,
      run: null,
    };
    this.conversations.set(conv.id, conv);
    return this.attachConversation(conv);
  }

  sessionNew(): { ok: boolean; message?: string } {
    // M22: 実行中でも新規会話を開始できる(既存ランには触らない)
    this.current = this.blankConv();
    return { ok: true };
  }

  /** M15-2: タイトル+本文の部分一致検索 */
  async sessionsSearch(query: string): Promise<SessionMeta[]> {
    return (await this.deps.sessions?.search?.(query)) ?? [];
  }

  /** M15-2: セッション名の変更(ロード済みの会話ならメモリ側のタイトルも同期) */
  async sessionRename(id: string, title: string): Promise<boolean> {
    const ok = (await this.deps.sessions?.rename?.(id, title)) ?? false;
    const conv = this.conversations.get(id);
    if (ok && conv) conv.title = title.trim().slice(0, 100);
    return ok;
  }

  async sessionDelete(id: string): Promise<void> {
    // M22: 実行中の会話は削除不可(先に停止する)
    if (this.conversations.get(id)?.run) {
      throw new Error('実行中のセッションは削除できない(先に停止してください)');
    }
    await this.deps.sessions?.delete(id);
    this.conversations.delete(id);
    if (this.current.id === id) this.current = this.blankConv();
  }

  /** M14-2: ctx.screenshot の注入(captureUrl 未設定なら注入しない=ツール側で明示エラー) */
  private screenshotContext(): { screenshot: { capture: NonNullable<AgentServiceDeps['captureUrl']> } } | Record<string, never> {
    const capture = this.deps.captureUrl;
    return capture ? { screenshot: { capture } } : {};
  }

  chatSend(
    text: string,
    mode: ChatMode,
    images?: ChatImageInput[],
    /** M25-2: 進化の自動再開だけが使う内部パラメータ(表示中でない依頼元会話でランを起動する) */
    targetConv?: ConvState,
  ): { sessionId: string; conversationId: string } {
    const planMode = mode === 'plan';
    const sessionId = randomUUID();
    const conv = targetConv ?? this.current;
    // 人間の送信で自動再開の上限カウンターをリセット(自動再開の連鎖は3回まで)
    if (targetConv === undefined) conv.autoResumeCount = 0;
    // M22: 全イベントに会話IDを付ける(renderer/remoteは表示中の会話だけ反映する)
    const emit = (event: AgentEvent): void => {
      if (event.kind === 'status' && conv.run?.sessionId === sessionId) {
        conv.run.lastStatus = event.status;
      }
      this.deps.bus.publish('chat:event', { ...event, conversationId: conv.id });
    };

    // M21-1: 実行中の送信はエラーにせず追加指示としてキューへ積む(次ターン境界で注入)
    if (conv.run) {
      const run = conv.run;
      if (text.trim() === '' && (images?.length ?? 0) === 0)
        return { sessionId: run.sessionId, conversationId: conv.id };
      run.pendingInstructions.push({
        text,
        ...(images && images.length > 0 ? { images } : {}),
      });
      emit({ kind: 'instruction_queued', sessionId: run.sessionId, text });
      return { sessionId: run.sessionId, conversationId: conv.id };
    }
    // M18: policy有効時のメイン会話は planner 帯。無効時は従来の単一モデル
    const policy = this.modelPolicy();
    const provider = policy ? this.createBandProvider('planner') : this.createProvider();
    if (typeof provider === 'string') {
      emit({ kind: 'error', sessionId, message: provider });
      emit({ kind: 'status', sessionId, status: 'error' });
      return { sessionId, conversationId: conv.id };
    }
    // M18: worker/escalation 帯のキー未登録は実行前に警告(横断構成の取りこぼし防止)。
    // worker はメイン(planner)のプロバイダで代行して続行する
    let workerProvider: LLMProvider = provider;
    // M19/M26-3: レビュー差し戻しfixの階段(1-2=worker → 3=midEscalation → 4+=escalation)
    let escalationProvider: LLMProvider = provider;
    let midEscalationProvider: LLMProvider = provider;
    // M26-3: 調査(mode:"read")サブエージェント用。未設定・キー未登録は worker で代行
    let explorerProvider: LLMProvider = provider;
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
      const m = this.createBandProvider('midEscalation');
      midEscalationProvider = typeof m === 'string' ? escalationProvider : m;
      const x = this.createBandProvider('explorer');
      if (typeof x === 'string') {
        emit({ kind: 'info', sessionId, message: `⚠ ${x} — 調査サブエージェントは worker 帯で代行します` });
        explorerProvider = workerProvider;
      } else {
        explorerProvider = x;
      }
    }
    // M19: レビュー・ゲートの実行状況(マイルストーン発動が無かったrunは完了時に1回縮退)
    let reviewRanThisRun = false;
    let producedOutput = false;
    // M26-2: このランでコア領域(聖域)に触れる書き込みがあったか(レビュー帯の格上げ判定)
    let coreAreaTouched = false;

    const ac = new AbortController();
    // M22: ラン状態(workspace束縛・会話単位のプロセス管理・追加指示キュー)
    const run: RunState = {
      sessionId,
      ac,
      startedAt: Date.now(),
      workspace: conv.workspace !== '' ? conv.workspace : this.getWorkspace(),
      processes: new ProcessManager(),
      pendingInstructions: [],
      lastStatus: 'calling_llm',
      model: `${this.currentLLM().provider}/${this.currentLLM().model}`,
    };
    conv.run = run;
    // 既存会話の workspace は黙って上書きしない。未記録(初送信)のみ束縛値を記録し、
    // 記録とグローバル設定が食い違う場合は警告を出す(会話の記録が優先される)
    if (conv.workspace === '') {
      conv.workspace = run.workspace;
    } else if (conv.workspace !== this.getWorkspace()) {
      emit({
        kind: 'info',
        sessionId,
        message: `この会話は ${conv.workspace} で作業します(現在の設定は ${this.getWorkspace()})`,
      });
    }
    // M14-2: 添付画像はテキストの後ろに image ブロックとして積む
    conv.history.push({
      role: 'user',
      content: [
        { type: 'text', text },
        ...(images ?? []).map((img): ChatMessage['content'][number] => ({ type: 'image', ...img })),
      ],
    });
    // M12-1: 会話の永続化メタ(初回送信時に確定。タイトルは先頭行)
    if (conv.title === '') {
      conv.title = ((text.split('\n')[0] ?? text).slice(0, 60) || '(無題)').trim() || '(無題)';
      conv.createdAt = new Date().toISOString();
    }
    this.conversations.set(conv.id, conv);
    this.publishRuns();
    // M22: 軟性しきい値 — 同時実行がしきい値を超えたら注意(止めない)
    const runningCount = this.runsList().length;
    if (runningCount > 5) {
      emit({
        kind: 'info',
        sessionId,
        message: `⚠ 同時実行が${runningCount}件になっています。APIレート制限や料金に注意(429は自動リトライで吸収されますが速度は落ちます)`,
      });
    }
    // M16-2: フォールバック発動後は以降の圧縮・保存もこのプロバイダで行う
    let runProvider: LLMProvider = provider;

    this.persistSession(conv, provider); // ユーザーメッセージを即座に保存(クラッシュ耐性)
    // M12-1: 各ターン完了(assistantメッセージ確定)ごとに随時保存する
    const emitWithPersist = (event: AgentEvent): void => {
      emit(event);
      if (event.kind === 'message_done') this.persistSession(conv, runProvider);
    };
    // M11-1: 設定された maxTurns をループへ配線(未設定ならループ既定の30)。
    // M27-1: freeMode 中の既定は15(明示設定があればそちらを優先)
    const maxTurns = effectiveMaxTurns(this.deps.config.get());

    /**
     * M16-2: 課金系エラー時のフォールバック。1会話1回・同一先への切替禁止。
     * 発動時は警告カード+audit記録+事前compaction(キャッシュ前提が崩れるため)。
     * M26-4: kind='refusal'(セーフガード拒否)は billing とは別枠のカウンタで1会話2回まで。
     * 同一プロバイダの1段下モデル(例 claude-fable-5 → Opus)を優先候補にし、
     * 段下が無いモデルのときだけ設定済みフォールバック先を使う
     */
    const acquireFallback = async (
      reason: string,
      kind?: 'billing' | 'refusal' | 'model_unavailable',
    ): Promise<LLMProvider | null> => {
      const isRefusal = kind === 'refusal';
      const isModelUnavailable = kind === 'model_unavailable';
      const current = this.currentLLM();
      let target: { provider: ProviderId; model: string };
      if (isRefusal) {
        if (conv.refusalFallbackCount >= 2) return null;
        const resolved = this.refusalFallbackLLM(conv.lastLLM ?? current);
        if (!resolved) return null;
        target = resolved;
      } else if (isModelUnavailable) {
        // M30-2: モデル未開放(404)→ 同一プロバイダの既知の安定モデルへ(1会話1回)。
        // ModelPolicy有効時も差し替わるのはこのループのプロバイダ(該当帯)だけで、帯構成は維持される
        if (conv.modelUnavailableFallbackUsed) return null;
        const resolved = this.stableFallbackLLM(conv.lastLLM ?? current);
        if (!resolved) return null;
        target = resolved;
      } else {
        const fb = this.deps.config.get().fallback;
        if (!fb || fb.enabled !== true) return null;
        if (conv.fallbackUsed) return null;
        const fbModel = fb.model.trim() !== '' ? fb.model : DEFAULT_MODELS[fb.provider];
        if (fb.provider === current.provider && fbModel === current.model) return null;
        target = { provider: fb.provider, model: fbModel };
      }

      let next: LLMProvider;
      if (this.deps.fallbackProviderFactory) {
        next = this.deps.fallbackProviderFactory(target.provider, target.model);
      } else {
        const key = this.deps.secrets.get(target.provider);
        if (!key) {
          emit({
            kind: 'info',
            sessionId,
            message: `フォールバック先(${target.provider})のAPIキーが未設定のため切り替えできない`,
          });
          return null;
        }
        next = this.track(
          target.provider === 'openai'
            ? new OpenAIProvider(key, target.model)
            : new AnthropicProvider(key, target.model),
          target.provider,
          target.model,
          'fallback',
        );
      }

      if (isRefusal) conv.refusalFallbackCount++;
      else if (isModelUnavailable) conv.modelUnavailableFallbackUsed = true;
      else conv.fallbackUsed = true;
      this.deps.audit.append({
        tool: 'provider-fallback',
        scope: 'system',
        paths: [],
        event: 'result',
        detail: `${
          isRefusal
            ? `refusal(${conv.refusalFallbackCount}/2): `
            : isModelUnavailable
              ? 'model-unavailable(1/1): '
              : ''
        }${current.provider}/${current.model} → ${target.provider}/${target.model}: ${reason.slice(0, 160)}`,
      });
      emit({
        kind: 'info',
        sessionId,
        message: isRefusal
          ? `⚠ セーフガードによる応答拒否を検知したため、代替モデル(${target.provider}/${target.model})で同一ターンをやり直します(${conv.refusalFallbackCount}/2回目)`
          : isModelUnavailable
            ? `⚠ モデル「${(conv.lastLLM ?? current).model}」が未開放/存在しない(404)ため、安定版(${target.provider}/${target.model})へ切り替えて続行します` +
              (this.modelPolicy() !== null ? '(該当帯のみ差し替え・帯構成は維持)' : '') +
              '。新モデルは段階開放のため、開放され次第元の設定で使えます'
            : `⚠ 残高/課金エラーを検知したため、フォールバック(${target.provider}/${target.model})へ切り替えて続行します: ${reason}`,
      });
      // 切替でprompt cacheが無効になるため、長い履歴は先に圧縮する(M16-1と同じ閾値)
      try {
        await this.maybeCompact(conv, next, ac.signal, {
          thresholdTokens: DEFAULT_COMPACTION_THRESHOLD,
          measuredTokens: Math.max(conv.lastPromptTokens, estimateTokens(conv.history)),
        });
      } catch {
        /* 圧縮失敗でも続行 */
      }
      conv.lastLLM = { provider: target.provider, model: target.model };
      run.model = `${target.provider}/${target.model}`;
      this.publishRuns();
      runProvider = next;
      return next;
    };

    void (async () => {
      // M16-1: プロバイダ/モデル切替を検知したら、キャッシュ前提が崩れるため先に圧縮する
      try {
        const switchInfo = await this.compactOnSwitch(conv, provider, ac.signal);
        if (switchInfo) emit({ kind: 'info', sessionId, message: switchInfo });
      } catch {
        /* 切替時圧縮の失敗は無視して通常応答へ進む */
      }
      // 履歴が閾値超なら圧縮してから応答する(M8-1、M13-1で実測トークントリガー化)。
      // 要約失敗は致命的でないため、失敗しても圧縮せず継続する。
      try {
        const compacted = await this.maybeCompact(conv, provider, ac.signal);
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
              name === 'plan' && effectiveReviewGate(this.deps.config.get())?.enabled === true
                ? readProjectPlan(run.workspace)
                : null;
            const result = await executeToolWithApproval(
              this.executorDeps({ workspace: run.workspace, conv }),
              name,
              input,
              {
              ...ctx,
              evolution: this.evolutionContext(conv),
              ...this.evolutionDisabledCtx(),
              processes: run.processes,
              userMemoryDir: this.deps.denyPaths.userDataDir,
              ...this.screenshotContext(),
              subagent: {
                // M18: サブエージェントは worker 帯(policy無効時はメインと同一)。
                // M26-3: 単発run(mode:"read"の調査)は安価な explorer 帯(未設定ならworker)
                run: (task, signal) =>
                  runSubAgent(
                    {
                      provider: explorerProvider,
                      tools: this.deps.registry,
                      cwd: run.workspace,
                      acquireFallback: this.acquireChildFallback(conv, emit, sessionId),
                    },
                    task,
                    signal,
                  ),
                // M12-3: 並列(read/work)。work は executor 経由で承認・スコープが効く。
                // M21-2: 同時数はAppConfig.subAgentMaxParallel(既定3・1〜8)
                // M26-3: read(調査)は explorer 帯、work(実装)は worker 帯
                runParallel: (tasks, subMode, signal) =>
                  this.runParallelSubAgents(
                    subMode === 'read' ? explorerProvider : workerProvider,
                    sessionId,
                    tasks,
                    subMode,
                    signal,
                  ),
                maxParallel: this.subAgentMaxParallel(),
              },
            });
            // M11-3: 書き込み/実行系ツールの成功直後に自動チェックポイント(メインループのみ)。
            // 失敗してもツール結果・ループは止めない(manager 側でログ済み)
            const risk = this.deps.registry.get(name)?.risk;
            if (result.isError !== true && (risk === 'write' || risk === 'exec')) {
              producedOutput = true;
              // M26-2: 聖域(コア領域)への書き込みを検知したら以降のレビューは planner 帯へ固定
              if (!coreAreaTouched && risk === 'write' && this.touchedCoreArea(name, input, run.workspace)) {
                coreAreaTouched = true;
              }
              await this.getCheckpoints(run.workspace)
                ?.snapshot(sessionId, `${name} 実行後`)
                .catch(() => null);
            }
            // M19: マイルストーン完了(- [ ]→- [x])を検知したらレビュー・ゲートを同期実行。
            // 要約を tool_result に追記するので、メインのモデル自身も合否を認識できる
            if (planBefore !== null && result.isError !== true) {
              const planAfter = readProjectPlan(run.workspace);
              const done = newlyCompleted(planBefore, planAfter);
              if (done.length > 0) {
                reviewRanThisRun = true;
                // M26-2: 未完了項目(- [ ])が残っていなければ最終マイルストーン → planner 帯でレビュー
                const finalMilestone = !/- \[ \]/.test(planAfter);
                const summary = await this.runReviewGate({
                  conv,
                  run,
                  emit,
                  sessionId,
                  milestone: done.join(' / '),
                  userRequest: text,
                  signal: ac.signal,
                  plannerProvider: runProvider,
                  forcePlannerReview: finalMilestone || coreAreaTouched,
                  workerProvider,
                  midEscalationProvider,
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
          // ユーザー方針(AMATERAS-USER.md・全プロジェクト共通)→プロジェクト記憶(AMATERAS.md)
          // →現在の計画(AMATERAS_PLAN.md)の順で system プロンプトへ注入する(M25 / M8-2 / M12-2)
          systemPrompt:
            composePlanSection(
              composeSystemPrompt(
                composeUserPolicySection(
                  SYSTEM_PROMPT,
                  readUserMemory(this.deps.denyPaths.userDataDir),
                ),
                readProjectMemory(run.workspace),
              ),
              readProjectPlan(run.workspace),
            ) +
            (policy ? POLICY_HINT : '') +
            (planMode ? PLAN_SUFFIX : ''),
          cwd: run.workspace,
          planMode,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          // M13-1: ループ内compaction(長い自走の途中でも実測トークンで圧縮)
          compact: async (measured) => {
            conv.lastPromptTokens = measured;
            try {
              await this.maybeCompact(conv, runProvider, ac.signal);
            } catch {
              /* 圧縮失敗でループは止めない */
            }
          },
          // M16-1: 1ターン完結でも実測値を保持する(切替時compactionの判定に使う)
          onUsage: (measured) => {
            conv.lastPromptTokens = measured;
          },
          // M16-2: 課金系エラー時のフォールバック(transientリトライはloop内蔵)
          acquireFallback,
          // M27-1: 無料APIモードの429はプリセット別の平易な文言で表示する
          describeLLMError: (err) => this.friendlyLLMError(err),
          // M21-1: 実行中に積まれた追加指示をターン境界で注入する
          drainInstructions: () => run.pendingInstructions.splice(0),
        },
        sessionId,
        conv.history,
        ac.signal,
      );
      // M19: 計画を使わなかった短いタスクは完了時に1回だけレビュー(縮退モード)。
      // 成果物(write/exec成功)が無い会話は対象外
      if (
        status === 'done' &&
        !reviewRanThisRun &&
        producedOutput &&
        effectiveReviewGate(this.deps.config.get())?.enabled === true
      ) {
        await this.runReviewGate({
          conv,
          run,
          emit,
          sessionId,
          milestone: '完成時レビュー',
          userRequest: text,
          signal: ac.signal,
          plannerProvider: runProvider,
          // M26-2: タスク全体の完成時レビューは最終マイルストーン相当として planner 帯で実施
          forcePlannerReview: true,
          workerProvider,
          midEscalationProvider,
          escalationProvider,
        });
      }
      // M29-5: 自律実行の終了時、仮導入(棚卸し待ち)があれば棚卸しカードを出す
      if (status === 'done' && conv.autonomous && this.provisionalInstalls.length > 0) {
        emit({ kind: 'inventory', sessionId, items: this.inventoryList() });
      }
      // M11-3: ループ完了時にも1回スナップショット(直近ツール以降の変更を確定)
      await this.getCheckpoints(run.workspace)
        ?.snapshot(sessionId, `セッション終了(${status})`)
        .catch(() => null);
      // M12-1: 終了時に最終状態を保存(tool_result 追記分を含めて確定)
      this.persistSession(conv, runProvider);
      return status;
    })().finally(() => {
      // M21-1: 未注入の追加指示は実行終了(完了/キャンセル/エラー)で破棄する
      // (キューは run に属するため、ランごと破棄される)
      run.processes.killAll();
      conv.run = null;
      this.publishRuns();
    });

    return { sessionId, conversationId: conv.id };
  }

  /**
   * M16-2×M18: サブエージェント(worker/escalation帯)用の課金エラーフォールバック。
   * メインの acquireFallback と同じ制限を共有(1会話1回・fallbackUsedFor)するが、
   * メインの実行プロバイダや lastLLM には触れない(子ループ内だけ切り替える)。
   * 子履歴は小さいため切替前compactionは省く
   */
  private acquireChildFallback(
    conv: ConvState,
    emit: (e: AgentEvent) => void,
    sessionId: string,
  ): (reason: string, kind?: 'billing' | 'refusal' | 'model_unavailable') => Promise<LLMProvider | null> {
    return async (reason, kind) => {
      const fb = this.deps.config.get().fallback;
      if (!fb || fb.enabled !== true) return null;
      // M26-4: refusal は billing(1会話1回)と別枠で1会話2回まで。子は帯モデルが多様で
      // 「1段下」を機械決定できないため、設定済みフォールバック先をそのまま使う。
      // M30-2: model_unavailable も同様(別枠1会話1回・設定済みフォールバック先へ)
      if (kind === 'refusal') {
        if (conv.refusalFallbackCount >= 2) return null;
      } else if (kind === 'model_unavailable') {
        if (conv.modelUnavailableFallbackUsed) return null;
      } else if (conv.fallbackUsed) return null;
      const fbModel = fb.model.trim() !== '' ? fb.model : DEFAULT_MODELS[fb.provider];
      let next: LLMProvider;
      if (this.deps.fallbackProviderFactory) {
        next = this.deps.fallbackProviderFactory(fb.provider, fbModel);
      } else {
        const key = this.deps.secrets.get(fb.provider);
        if (!key) return null;
        next = this.track(
          fb.provider === 'openai' ? new OpenAIProvider(key, fbModel) : new AnthropicProvider(key, fbModel),
          fb.provider,
          fbModel,
          'fallback',
        );
      }
      if (kind === 'refusal') conv.refusalFallbackCount++;
      else if (kind === 'model_unavailable') conv.modelUnavailableFallbackUsed = true;
      else conv.fallbackUsed = true;
      this.deps.audit.append({
        tool: 'provider-fallback',
        scope: 'system',
        paths: [],
        event: 'result',
        detail: `${
          kind === 'refusal'
            ? `refusal(${conv.refusalFallbackCount}/2): `
            : kind === 'model_unavailable'
              ? 'model-unavailable(1/1): '
              : ''
        }subagent → ${fb.provider}/${fbModel}: ${reason.slice(0, 160)}`,
      });
      emit({
        kind: 'info',
        sessionId,
        message:
          kind === 'refusal'
            ? `⚠ サブエージェントでセーフガード拒否を検知したため、フォールバック(${fb.provider}/${fbModel})でやり直します(${conv.refusalFallbackCount}/2回目)`
            : `⚠ サブエージェントで残高/課金エラーを検知したため、フォールバック(${fb.provider}/${fbModel})へ切り替えて続行します: ${reason}`,
      });
      return next;
    };
  }

  /**
   * M18: work サブエージェントの格上げ依存。policy 無効・escalation帯キー未設定なら undefined
   * (=格上げ無効)。格上げ前に子履歴を compaction 経由(キャッシュ前提が変わるため)
   */
  private buildEscalateDeps(
    sessionId: string,
    emit: (e: AgentEvent) => void,
  ):
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
        emit({
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
    conv: ConvState;
    run: RunState;
    emit: (e: AgentEvent) => void;
    sessionId: string;
    milestone: string;
    userRequest: string;
    signal: AbortSignal;
    plannerProvider: LLMProvider;
    /**
     * M26-2: true=planner帯でレビュー(最終マイルストーン完了時・コア領域に触れた変更・
     * 進化昇格前)。false=reviewer帯(未指定なら planner 代行)で日常レビュー
     */
    forcePlannerReview: boolean;
    workerProvider: LLMProvider;
    midEscalationProvider: LLMProvider;
    escalationProvider: LLMProvider;
  }): Promise<string | null> {
    // M26-9(T9): 本体は review/gateRunner.ts へ機械的に抽出(挙動変更なし)。
    // service 依存(帯プロバイダ・fix実行・承認ブローカー・audit)をコールバックで注入する
    return runReviewGateStep(
      {
        cfg: effectiveReviewGate(this.deps.config.get()),
        registry: this.deps.registry,
        ...(this.deps.captureUrl !== undefined ? { captureUrl: this.deps.captureUrl } : {}),
        auditAppend: (detail) =>
          this.deps.audit.append({ tool: 'review-gate', scope: 'system', paths: [], event: 'result', detail }),
        createReviewerProvider: () => this.createBandProvider('reviewer'),
        runFix: async (provider, task, signal) => {
          await this.runParallelSubAgents(provider, args.sessionId, [task], 'work', signal, {
            conv: args.conv,
            run: args.run,
            emit: args.emit,
          });
        },
        requestApproval: (inputPreview, warning, signal) =>
          this.broker.request({ toolName: 'review-gate', risk: 'safe', inputPreview, warnings: [warning] }, signal),
        readPlan: readProjectPlan,
      },
      {
        workspace: args.run.workspace,
        emit: args.emit,
        sessionId: args.sessionId,
        milestone: args.milestone,
        userRequest: args.userRequest,
        signal: args.signal,
        autonomous: args.conv.autonomous,
        plannerProvider: args.plannerProvider,
        forcePlannerReview: args.forcePlannerReview,
        workerProvider: args.workerProvider,
        midEscalationProvider: args.midEscalationProvider,
        escalationProvider: args.escalationProvider,
      },
    );
  }

  /**
   * M12-3: 並列サブエージェント。fan-out 直前に自動チェックポイントを作り、
   * work モードでは write 衝突テーブルを全子で共有する。親 signal で全子キャンセル。
   * (public なのはテストのため。通常は chatSend 内の ctx.subagent.runParallel 経由)
   */
  /** M21-2: 並列サブエージェント同時数の実効値(未設定=既定3。1〜8にクランプ) */
  private subAgentMaxParallel(): number {
    const raw = this.deps.config.get().subAgentMaxParallel;
    return raw !== undefined ? Math.min(8, Math.max(1, Math.round(raw))) : MAX_PARALLEL_SUBAGENTS;
  }

  async runParallelSubAgents(
    provider: LLMProvider,
    sessionId: string,
    tasks: string[],
    mode: 'read' | 'work',
    signal: AbortSignal,
    /** M22: ラン束縛(workspace固定・会話単位の自律/フォールバック・イベント帰属)。省略時は現在の会話 */
    binding?: { conv: ConvState; run: RunState; emit: (e: AgentEvent) => void },
  ): Promise<string[]> {
    const conv = binding?.conv ?? this.current;
    const ws = binding?.run.workspace ?? this.getWorkspace();
    const emit =
      binding?.emit ??
      ((e: AgentEvent): void => this.deps.bus.publish('chat:event', { ...e, conversationId: conv.id }));
    const limited = tasks.slice(0, this.subAgentMaxParallel());
    await this.getCheckpoints(ws)
      ?.snapshot(sessionId, `サブエージェント並列実行前(${mode}×${limited.length})`)
      .catch(() => null);
    const locks = new WriteLockTable();
    // M23: 子が使うモデルの表示ラベル(read=explorer帯/work=worker帯。格上げ済みはescalation帯)
    const workerLLM = this.bandLLM(mode === 'read' ? 'explorer' : 'worker') ?? this.currentLLM();
    const escLLM = this.bandLLM('escalation') ?? workerLLM;
    const onUpdate = (u: SubAgentUpdate): void =>
      this.deps.bus.publish('agent:sub_update', {
        ...u,
        conversationId: conv.id,
        model: u.escalated === true ? escLLM.model : workerLLM.model,
      });
    const rawTurns = this.deps.config.get().subAgentMaxTurns;
    const maxTurns =
      rawTurns !== undefined ? Math.min(100, Math.max(1, Math.round(rawTurns))) : undefined;
    // M18: 格上げ(policy有効時のみ)とサブ用フォールバック
    const escalate = this.buildEscalateDeps(sessionId, emit);
    const acquireFallback = this.acquireChildFallback(conv, emit, sessionId);
    const execDeps = this.executorDeps(
      binding !== undefined ? { workspace: ws, conv } : undefined,
    );

    return Promise.all(
      limited.map((task) => {
        const id = ++this.subAgentSeq;
        if (mode === 'work') {
          return runWorkSubAgent(
            {
              provider,
              tools: this.deps.registry,
              cwd: ws,
              executeTool: (name, input, ctx) =>
                executeToolWithApproval(execDeps, name, input, {
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
        const startedAt = Date.now();
        onUpdate({ id, task: label, mode: 'read', status: 'running', startedAt });
        return runSubAgent(
          { provider, tools: this.deps.registry, cwd: ws, acquireFallback },
          task,
          signal,
        ).then((summary) => {
          onUpdate({
            id,
            task: label,
            mode: 'read',
            status: signal.aborted ? 'cancelled' : 'done',
            startedAt,
            summaryTail: summary.slice(-200),
          });
          return summary;
        });
      }),
    );
  }

  chatCancel(sessionId: string): void {
    // M22: sessionId からランを特定して止める(他の会話のランには触らない)
    for (const conv of this.conversations.values()) {
      if (conv.run?.sessionId === sessionId) {
        conv.run.ac.abort();
        // M11-2: セッションキャンセルでそのランのバックグラウンドプロセスも全て止める
        conv.run.processes.killAll();
        return;
      }
    }
  }

  /** アプリ終了時の後始末(index.ts の will-quit から呼ばれる) */
  shutdown(): void {
    this.processes.killAll();
    for (const conv of this.conversations.values()) {
      conv.run?.ac.abort();
      conv.run?.processes.killAll();
    }
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
    // M29-5: 仮導入(棚卸し未確定)のツールに「仮」マークを付ける
    const provisionalNames = new Set(this.provisionalInstalls.map((p) => p.toolName));
    return {
      tools: this.deps.registry.list().map((p) => ({
        name: p.name,
        description: p.description,
        risk: p.risk,
        warnings: p.warnings ?? [],
        tags: p.tags ?? [],
        ...(provisionalNames.has(p.name) ? { provisional: true } : {}),
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
        ...this.evolutionDisabledCtx(),
        processes: this.processes,
        userMemoryDir: this.deps.denyPaths.userDataDir,
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

  // ---- フォルダで開く(整理1): ディレクトリも可・denyのみ適用 ----

  async fileRevealTarget(path: string): Promise<RevealResolveResult> {
    return resolveRevealTarget(path, {
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
    // M22: 現在のworkspaceで実行中のランがある間は復元不可(実行中の書き込みと衝突するため)
    const ws = this.getWorkspace();
    const busy = [...this.conversations.values()].some((c) => c.run !== null && c.run.workspace === ws);
    if (busy) {
      return { ok: false, message: 'このworkspaceでエージェント実行中は復元できない(完了かキャンセル後に実行)' };
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

  async evolutionEnqueue(
    description: string,
    expectedIO: string,
    scope?: EvolutionScope,
  ): Promise<{ jobId: number }> {
    return {
      jobId: await this.evolution.enqueue({ description, expectedIO, ...(scope !== undefined ? { scope } : {}) }),
    };
  }

  /**
   * M27-4: プラグインインポートの開始。ディレクトリを検査(manifest検証+権限静的解析)し、
   * 合格なら進化ジョブとして enqueue する(以降は既存の検証ゲート→承認→昇格と同一経路。
   * ゲートの省略は不可)。既存ツールと同名なら「既存修正(targetTool)」として扱う
   */
  async pluginImportStart(dir: string): Promise<PluginImportStartResult> {
    const inspection = await inspectImportDir(dir);
    if (!inspection.ok || inspection.manifest === undefined) {
      return { ok: false, message: `インポート検査に失敗:\n${inspection.errors.join('\n')}` };
    }
    const m = inspection.manifest;
    const exists = this.deps.registry.get(m.name) !== undefined;
    const jobId = await this.evolution.enqueue({
      description: `コミュニティプラグイン「${m.name}」のインポート(v${m.version})`,
      expectedIO: m.description,
      scope: 'tool',
      importFrom: dir,
      ...(exists ? { targetTool: m.name } : {}),
    });
    return {
      ok: true,
      message:
        (exists
          ? `既存ツール「${m.name}」の更新としてインポートを開始した(ジョブ#${jobId})`
          : `インポートを開始した(ジョブ#${jobId})`) +
        '。検証ゲート(typecheck→vitest→スモーク)合格後に承認ダイアログが出ます',
      jobId,
      manifest: m,
      warnings: inspection.warnings,
    };
  }

  evolutionPromoteRespond(jobId: number, approved: boolean): void {
    const resolve = this.pendingPromotions.get(jobId);
    if (resolve) {
      this.pendingPromotions.delete(jobId);
      this.pendingPromotionEvents.delete(jobId);
      resolve(approved);
    }
  }

  /** M26-6: 進化ジョブのキャンセル(queued=キュー除去/実行中=abort) */
  evolutionCancel(jobId: number): { ok: boolean } {
    return { ok: this.evolution.cancel?.(jobId) === true };
  }

  getPendingPromotionRequests(): PromotionRequestEvent[] {
    return [...this.pendingPromotionEvents.values()];
  }

  // ---- 状態(リモートUIの snapshot / /api/status 用) ----

  getStatus(): AgentStatusView {
    const run = this.current.run;
    return {
      status: run ? run.lastStatus : 'idle',
      activeSessionId: run?.sessionId ?? null,
      scopeMode: this.deps.config.get().scopeMode,
      autonomous: this.current.autonomous,
    };
  }

  getHistoryView(): HistoryMessageView[] {
    return toHistoryView(this.current.history);
  }

  /** M22: 現在表示中の会話ID(remote snapshot・イベントフィルタ用) */
  getCurrentConversationId(): string {
    return this.current.id;
  }
}
