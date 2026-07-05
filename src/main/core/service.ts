import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentStatus,
  AgentStatusView,
  AppConfig,
  ApprovalDecision,
  ApprovalRequestPayload,
  ChatMode,
  CheckpointInfo,
  CheckpointRestoreResult,
  EvolutionEvent,
  EvolutionJobSummary,
  HistoryMessageView,
  PluginErrorInfo,
  ProviderId,
  SessionLoadResult,
  SessionMeta,
  SubAgentUpdate,
  ToolExecResultPayload,
  ToolInfo,
} from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { compactHistory, estimateTokens } from '../agent/compaction';
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
import {
  executeToolWithApproval,
  type ExecutorDeps,
  type ScopeAuditEvent,
  type ScopePolicy,
} from '../tools/executor';
import type { ToolPlugin } from '../tools/types';
import type { EventBus } from './events';
import { ProcessManager } from './processes';
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
  config: { get(): AppConfig };
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
}

const SYSTEM_PROMPT = `あなたは MyCodex — ユーザーのマシン上で動くコーディングエージェント。
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

/** 会話履歴を表示用に整形する(tool_result のみのメッセージは省く) */
export function toHistoryView(messages: ChatMessage[]): HistoryMessageView[] {
  const views: HistoryMessageView[] = [];
  for (const msg of messages) {
    const parts: string[] = [];
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.trim() !== '') parts.push(block.text);
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
  private conversation: { id: string; title: string; createdAt: string } | null = null;
  /** M12-3: 子エージェントの連番(UI表示・承認ダイアログの出所表示用) */
  private subAgentSeq = 0;
  /** M13-1: 直近APIコールの実測プロンプトトークン(compaction発火判定用) */
  private lastPromptTokens = 0;
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
    };
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
   * M13-1: 実測トークン(直近APIコールの input+cache_read)がモデル上限の70%を超えたら
   * 履歴を圧縮する。要約で消える範囲の普遍的知見は MYCODEX.md の学習メモへ退避される。
   * 圧縮したら lastPromptTokens をリセット(次のAPIコールで再実測されるまで未知のため)
   */
  private async maybeCompact(provider: LLMProvider, signal: AbortSignal): Promise<boolean> {
    const cfg = this.deps.config.get();
    const model = cfg.model || DEFAULT_MODELS[cfg.provider];
    const threshold = Math.floor(contextLimitFor(model) * 0.7);
    const compacted = await compactHistory(provider, this.history, {
      signal,
      measuredTokens: this.lastPromptTokens,
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
    // 履歴配列は loop と参照共有しているため、置換ではなく中身を差し替える
    this.history.length = 0;
    this.history.push(...data.history);
    this.conversation = { id: data.id, title: data.title, createdAt: data.createdAt };
    // 実測値は次のAPIコールまで無いので推定で近似(M13-1)
    this.lastPromptTokens = estimateTokens(this.history);
    return { ok: true, history: toHistoryView(this.history) };
  }

  sessionNew(): { ok: boolean; message?: string } {
    if (this.activeRun) return { ok: false, message: 'エージェント実行中は新規セッションを開始できない' };
    this.history.length = 0;
    this.conversation = null;
    this.lastPromptTokens = 0;
    return { ok: true };
  }

  async sessionDelete(id: string): Promise<void> {
    await this.deps.sessions?.delete(id);
    // 表示中の会話を消した場合はメモリ側もリセット(実行中は触らない)
    if (this.conversation?.id === id && !this.activeRun) {
      this.history.length = 0;
      this.conversation = null;
    }
  }

  chatSend(text: string, mode: ChatMode): { sessionId: string } {
    const planMode = mode === 'plan';
    const sessionId = randomUUID();
    const emit = (event: AgentEvent): void => this.emitChat(event);

    if (this.activeRun) {
      emit({ kind: 'error', sessionId, message: '別の実行が進行中' });
      emit({ kind: 'status', sessionId, status: 'error' });
      return { sessionId };
    }
    const provider = this.createProvider();
    if (typeof provider === 'string') {
      emit({ kind: 'error', sessionId, message: provider });
      emit({ kind: 'status', sessionId, status: 'error' });
      return { sessionId };
    }

    const ac = new AbortController();
    this.activeRun = { sessionId, ac };
    this.history.push({ role: 'user', content: [{ type: 'text', text }] });
    // M12-1: 会話の永続化メタ(初回送信時に確定。タイトルは先頭行)
    if (!this.conversation) {
      this.conversation = {
        id: randomUUID(),
        title: (text.split('\n')[0] ?? text).slice(0, 60),
        createdAt: new Date().toISOString(),
      };
    }
    this.persistSession(provider); // ユーザーメッセージを即座に保存(クラッシュ耐性)
    // M12-1: 各ターン完了(assistantメッセージ確定)ごとに随時保存する
    const emitWithPersist = (event: AgentEvent): void => {
      emit(event);
      if (event.kind === 'message_done') this.persistSession(provider);
    };
    // M11-1: 設定された maxTurns をループへ配線(未設定ならループ既定の30)
    const maxTurns = this.deps.config.get().maxTurns;

    void (async () => {
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
            const result = await executeToolWithApproval(this.executorDeps(), name, input, {
              ...ctx,
              evolution: this.evolutionContext(),
              processes: this.processes,
              subagent: {
                run: (task, signal) =>
                  runSubAgent(
                    { provider, tools: this.deps.registry, cwd: this.getWorkspace() },
                    task,
                    signal,
                  ),
                // M12-3: 最大3並列(read/work)。work は executor 経由で承認・スコープが効く
                runParallel: (tasks, subMode, signal) =>
                  this.runParallelSubAgents(provider, sessionId, tasks, subMode, signal),
              },
            });
            // M11-3: 書き込み/実行系ツールの成功直後に自動チェックポイント(メインループのみ)。
            // 失敗してもツール結果・ループは止めない(manager 側でログ済み)
            const risk = this.deps.registry.get(name)?.risk;
            if (result.isError !== true && (risk === 'write' || risk === 'exec')) {
              await this.getCheckpoints()
                ?.snapshot(sessionId, `${name} 実行後`)
                .catch(() => null);
            }
            return result;
          },
          emit: emitWithPersist,
          // プロジェクト記憶(MYCODEX.md)と現在の計画(MYCODEX_PLAN.md)を
          // system プロンプトへ注入する(M8-2 / M12-2)
          systemPrompt:
            composePlanSection(
              composeSystemPrompt(SYSTEM_PROMPT, readProjectMemory(this.getWorkspace())),
              readProjectPlan(this.getWorkspace()),
            ) + (planMode ? PLAN_SUFFIX : ''),
          cwd: this.getWorkspace(),
          planMode,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          // M13-1: ループ内compaction(長い自走の途中でも実測トークンで圧縮)
          compact: async (measured) => {
            this.lastPromptTokens = measured;
            try {
              await this.maybeCompact(provider, ac.signal);
            } catch {
              /* 圧縮失敗でループは止めない */
            }
          },
        },
        sessionId,
        this.history,
        ac.signal,
      );
      // M11-3: ループ完了時にも1回スナップショット(直近ツール以降の変更を確定)
      await this.getCheckpoints()
        ?.snapshot(sessionId, `セッション終了(${status})`)
        .catch(() => null);
      // M12-1: 終了時に最終状態を保存(tool_result 追記分を含めて確定)
      this.persistSession(provider);
      return status;
    })().finally(() => {
      this.activeRun = null;
    });

    return { sessionId };
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
                executeToolWithApproval(this.executorDeps(), name, input, ctx),
              onUpdate,
              locks,
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
          { provider, tools: this.deps.registry, cwd: this.getWorkspace() },
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
      },
    );
    return { content: result.content, isError: result.isError === true };
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
    };
  }

  getHistoryView(): HistoryMessageView[] {
    return toHistoryView(this.history);
  }
}
