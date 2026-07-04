import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  AgentStatus,
  AgentStatusView,
  AppConfig,
  ApprovalDecision,
  ApprovalRequestPayload,
  ChatMode,
  EvolutionEvent,
  EvolutionJobSummary,
  HistoryMessageView,
  PluginErrorInfo,
  ProviderId,
  ToolExecResultPayload,
  ToolInfo,
} from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { compactHistory } from '../agent/compaction';
import { runAgentLoop } from '../agent/loop';
import { runSubAgent } from '../agent/subagent';
import { composeSystemPrompt, readProjectMemory } from '../memory';
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
}

const SYSTEM_PROMPT = `あなたは MyCodex — ユーザーのマシン上で動くコーディングエージェント。
与えられたツールを使ってファイルの調査・編集・コマンド実行を行い、ユーザーの指示を完遂する。

規範:
- 手を動かす前に不明点があれば read_file / list_dir / grep で自分で調べる
- 変更は最小限に。既存のコードスタイルに合わせる
- 破壊的な操作は慎重に。ツール実行はユーザー承認制の場合がある
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
  private readonly pendingPromotions = new Map<number, (approved: boolean) => void>();
  private readonly pendingPromotionEvents = new Map<number, PromotionRequestEvent>();

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
    };
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
    // M11-1: 設定された maxTurns をループへ配線(未設定ならループ既定の30)
    const maxTurns = this.deps.config.get().maxTurns;

    void (async () => {
      // 履歴が閾値超なら古いやり取りを要約に畳んでから応答する(M8-1)。
      // 要約失敗は致命的でないため、失敗しても圧縮せず継続する。
      try {
        const compacted = await compactHistory(provider, this.history, { signal: ac.signal });
        if (compacted) emit({ kind: 'status', sessionId, status: 'calling_llm' });
      } catch {
        /* 圧縮失敗は無視して通常応答へ進む */
      }
      return runAgentLoop(
        {
          provider,
          // プランモードではツール定義を渡さない(モデルがtool_useを出せない)。
          // 併せて loop 側 planMode でも実行を機械的に禁止する(二重防御)。
          tools: planMode ? { list: () => [] } : this.deps.registry,
          executeTool: (name, input, ctx) =>
            executeToolWithApproval(this.executorDeps(), name, input, {
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
              },
            }),
          emit,
          // プロジェクト記憶(MYCODEX.md)を system プロンプトへ注入する(M8-2)
          systemPrompt:
            composeSystemPrompt(SYSTEM_PROMPT, readProjectMemory(this.getWorkspace())) +
            (planMode ? PLAN_SUFFIX : ''),
          cwd: this.getWorkspace(),
          planMode,
          ...(maxTurns !== undefined ? { maxTurns } : {}),
        },
        sessionId,
        this.history,
        ac.signal,
      );
    })().finally(() => {
      this.activeRun = null;
    });

    return { sessionId };
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
