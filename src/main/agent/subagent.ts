import { resolve } from 'node:path';
import type { SubAgentUpdate } from '../../shared/types';
import type { ChatMessage, LLMProvider } from '../providers/types';
import { collectDeclaredPaths } from '../tools/executor';
import type { ToolContext, ToolPlugin, ToolResult } from '../tools/types';
import { runAgentLoop } from './loop';

/**
 * サブエージェント(M8-4 / M12-3)。タスクを別コンテキスト(独立した history)の
 * 子エージェントに委譲する。子の生ログ(ツール往復)は親履歴に入らず、
 * 最後の要約テキストだけを返す。→ 親履歴の肥大を防ぎつつ、重い作業を別コンテキストへ逃がす。
 * - read(既定): 読み取り専用ツール(safe)のみ。承認は挟まない
 * - work(M12-3): 全ツール(進化・ネスト・plan を除く)を executor=承認フロー経由で使う。
 *   親キャンセルで全子キャンセル。write の衝突は WriteLockTable で2件目以降を拒否
 */

export interface SubAgentTools {
  list(): ToolPlugin[];
  get(name: string): ToolPlugin | undefined;
}

export interface SubAgentDeps {
  provider: LLMProvider;
  /** 親のツール群。この中の safe ツールだけを子に見せる */
  tools: SubAgentTools;
  cwd: string;
  maxTurns?: number;
  /** M18: 課金エラー時のフォールバック(M16-2を子ループにも適用。制限は親が共有管理) */
  acquireFallback?: (reason: string, kind?: 'billing' | 'refusal') => Promise<LLMProvider | null>;
}

const SUBAGENT_PROMPT = `あなたは調査専門のサブエージェント。与えられた調査タスクを、
読み取り専用ツール(read_file / list_dir / grep)だけを使って遂行する。
ファイルの変更やコマンド実行はできない。十分に調べたら、呼び出し元が使えるよう
「結論と根拠(該当ファイル・行・要点)」を簡潔な日本語で要約して返答せよ。`;

/**
 * 子に見せてよいツール(読み取り専用)。進化・サブエージェント自身は除外し再帰・副作用を防ぐ。
 * plan(M12-2)/ memory(M13-1)は risk:'safe' だが書き込みアクションを持つため除外する。
 * mcp__(M13-2)は外部プロセスのツールで、この経路は承認を挟まないため除外する
 */
function isReadOnlyDelegable(p: ToolPlugin): boolean {
  return (
    p.risk === 'safe' &&
    p.name !== 'request_capability' &&
    p.name !== 'dispatch_agent' &&
    p.name !== 'plan' &&
    p.name !== 'memory' &&
    !p.name.startsWith('mcp__')
  );
}

export async function runSubAgent(deps: SubAgentDeps, task: string, signal: AbortSignal): Promise<string> {
  const readOnly = deps.tools.list().filter(isReadOnlyDelegable);
  const history: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: task }] }];

  const status = await runAgentLoop(
    {
      provider: deps.provider,
      tools: { list: () => readOnly },
      // 読み取り専用の実行。承認は挟まない(safeのみ)。非safeは機械的に拒否する。
      executeTool: async (name, input, ctx: ToolContext) => {
        const plugin = deps.tools.get(name);
        if (!plugin || !isReadOnlyDelegable(plugin)) {
          return { content: `サブエージェントは読み取り専用ツールのみ使用可(拒否: ${name})`, isError: true };
        }
        return plugin.execute(input, ctx);
      },
      emit: () => {}, // 子のイベントは親のUI/履歴に流さない
      systemPrompt: SUBAGENT_PROMPT,
      cwd: deps.cwd,
      maxTurns: deps.maxTurns ?? 15,
      ...(deps.acquireFallback !== undefined ? { acquireFallback: deps.acquireFallback } : {}),
    },
    'subagent',
    history,
    signal,
  );

  const summary = history
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (status === 'cancelled') return '(サブエージェントはキャンセルされた)';
  return summary || '(サブエージェントは要約を返さなかった)';
}

// ---- M12-3: 並列・work モード ----

export const MAX_PARALLEL_SUBAGENTS = 3;
export const WORK_SUBAGENT_DEFAULT_MAX_TURNS = 30;

/**
 * 子に見せてよいツール(work モード)。
 * - dispatch_agent: ネスト禁止(1段まで)
 * - request_capability: 進化は親(ユーザー対話)からのみ
 * - plan: 計画ファイルは親が単独管理する(並列の子が同時に書き換えると壊れる)
 * - memory: 記憶も親が単独管理(並列の子の同時追記で壊さない)
 *   ※mcp__ ツールは executor(承認フロー)経由のため work では許可
 */
function isWorkDelegable(p: ToolPlugin): boolean {
  return (
    p.name !== 'dispatch_agent' &&
    p.name !== 'request_capability' &&
    p.name !== 'plan' &&
    p.name !== 'memory'
  );
}

/**
 * 並列 work 子エージェント間の write 衝突防止。最初に書いた子がそのパスを所有し、
 * 他の子の write は isError で拒否される(fan-out 1回ごとに使い捨て)。
 */
export class WriteLockTable {
  private readonly owners = new Map<string, number>();

  claim(path: string, ownerId: number): { ok: true } | { ok: false; ownerId: number } {
    // Windows はパス大文字小文字非依存のため正規化して照合する
    const key = resolve(path).toLowerCase();
    const current = this.owners.get(key);
    if (current === undefined) {
      this.owners.set(key, ownerId);
      return { ok: true };
    }
    return current === ownerId ? { ok: true } : { ok: false, ownerId: current };
  }
}

export interface WorkSubAgentDeps {
  provider: LLMProvider;
  tools: SubAgentTools;
  cwd: string;
  maxTurns?: number;
  /**
   * 親(AgentService)の executor 束縛。承認・スコープ判定・監査・編集後フックが
   * そのまま効く(= 子も executeToolWithApproval を必ず経由する)
   */
  executeTool: (name: string, input: unknown, ctx: ToolContext) => Promise<ToolResult>;
  onUpdate?: (u: SubAgentUpdate) => void;
  /** 並列実行時の write 衝突テーブル(fan-out 側で生成して全子に共有) */
  locks?: WriteLockTable;
  /** M18: 課金エラー時のフォールバック(M16-2を子ループにも適用) */
  acquireFallback?: (reason: string, kind?: 'billing' | 'refusal') => Promise<LLMProvider | null>;
  /**
   * M18: 格上げ(エスカレーション)。子が (a)status error (b)maxTurns到達
   * (c)ツール失敗3連続 で終わったら、履歴を compaction 経由で escalation 帯プロバイダに
   * 引き継いで再試行する(最大 maxPerTask 回。格上げ先でも失敗したら通常のエラー扱い)
   */
  escalate?: {
    provider: LLMProvider;
    maxPerTask: number;
    compact: (history: ChatMessage[], signal: AbortSignal) => Promise<void>;
    onEscalate: (id: number, attempt: number, reason: string) => void;
  };
}

/** M18: 格上げトリガー(c)の閾値 — ツール失敗(isError または 編集後フック失敗)の連続数 */
export const ESCALATE_AFTER_CONSECUTIVE_FAILURES = 3;

/** 編集後フックの失敗を tool_result 本文から検出する(executor が付記する形式に依存) */
function hookFailed(content: string): boolean {
  return (
    content.includes('[post-edit hook]') &&
    (/\[フック exit code: -?[1-9]/.test(content) || content.includes('フックはタイムアウト'))
  );
}

const WORK_PROMPT = (id: number): string => `あなたは作業サブエージェント #${id}。
親エージェントから割り当てられた1つのタスクを完遂する。
- ツールで調査・編集・コマンド実行ができる(書き込み等はユーザー承認制の場合がある)
- 割り当てタスクに関係ないファイルには触らない(他の子エージェントが並列で動いている)
- 完了したら、行った変更(ファイル・要点)と検証結果を簡潔な日本語で要約して返答せよ`;

function extractSummary(history: ChatMessage[]): string {
  return history
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/** work モードの子エージェント1体を実行する。戻り値は要約テキスト */
export async function runWorkSubAgent(
  deps: WorkSubAgentDeps,
  id: number,
  task: string,
  signal: AbortSignal,
): Promise<string> {
  const delegable = deps.tools.list().filter(isWorkDelegable);
  const history: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: task }] }];
  const taskLabel = task.length > 120 ? `${task.slice(0, 120)}…` : task;
  let escalated = false;
  const startedAt = Date.now();
  const emitUpdate = (partial: Partial<SubAgentUpdate>): void =>
    deps.onUpdate?.({
      id,
      task: taskLabel,
      mode: 'work',
      status: 'running',
      startedAt,
      ...(escalated ? { escalated: true } : {}),
      ...partial,
    });

  // M21-4: 最新思考(ストリーミングテキスト)のライブ通知。500msスロットルでUIへ流す
  let narrationBuf = '';
  let lastNarrationAt = 0;
  const onChildEvent = (e: import('../../shared/types').AgentEvent): void => {
    if (e.kind === 'text_delta') {
      narrationBuf += e.text;
      const now = Date.now();
      if (now - lastNarrationAt >= 500) {
        lastNarrationAt = now;
        emitUpdate({ narration: narrationBuf.slice(-200) });
      }
    } else if (e.kind === 'message_done') {
      if (narrationBuf !== '') emitUpdate({ narration: narrationBuf.slice(-200) });
      narrationBuf = '';
    }
  };

  // M18: 格上げトリガー(c)用 — ツール失敗(isError / 編集後フック失敗)の連続数
  let consecutiveFailures = 0;

  const runOnce = (provider: LLMProvider): Promise<import('../../shared/types').AgentStatus> =>
    runAgentLoop(
      {
        provider,
        tools: { list: () => delegable },
        executeTool: async (name, input, ctx) => {
          const plugin = deps.tools.get(name);
          if (!plugin || !isWorkDelegable(plugin)) {
            return { content: `サブエージェントでは使用不可のツール: ${name}`, isError: true };
          }
          // write 衝突: 同一パスは最初に書いた子が所有する(2件目以降は拒否)
          if (deps.locks && plugin.risk === 'write') {
            for (const p of collectDeclaredPaths(plugin, input, ctx.cwd)) {
              const claim = deps.locks.claim(p, id);
              if (!claim.ok) {
                return {
                  content:
                    `書き込み衝突: ${p} はサブエージェント #${claim.ownerId} が編集中。` +
                    `並列タスクは触るファイルが重ならないように分割すること`,
                  isError: true,
                };
              }
            }
          }
          emitUpdate({ currentTool: name });
          const result = await deps.executeTool(name, input, { ...ctx, subAgentId: id });
          if (result.isError === true || hookFailed(result.content)) consecutiveFailures++;
          else consecutiveFailures = 0;
          return result;
        },
        // 子の生イベントは親のチャットへ流さない。M21-4: 思考テキストだけ onUpdate で間引き通知
        emit: onChildEvent,
        systemPrompt: WORK_PROMPT(id),
        cwd: deps.cwd,
        maxTurns: deps.maxTurns ?? WORK_SUBAGENT_DEFAULT_MAX_TURNS,
        ...(deps.acquireFallback !== undefined ? { acquireFallback: deps.acquireFallback } : {}),
      },
      `subagent-${id}`,
      history,
      signal,
    );

  emitUpdate({});
  let status = await runOnce(deps.provider);

  // M18: 格上げ(エスカレーション)。escalation 帯でも失敗したらそれ以上は上げない
  let attempts = 0;
  while (
    deps.escalate !== undefined &&
    attempts < deps.escalate.maxPerTask &&
    !signal.aborted &&
    (status === 'error' ||
      status === 'max_turns_reached' ||
      consecutiveFailures >= ESCALATE_AFTER_CONSECUTIVE_FAILURES)
  ) {
    attempts++;
    const reason =
      status !== 'done'
        ? `status: ${status}`
        : `ツール失敗が${consecutiveFailures}連続`;
    deps.escalate.onEscalate(id, attempts, reason);
    escalated = true;
    emitUpdate({});
    // キャッシュ前提が変わるため、格上げ前に子履歴を compaction 経由(M16-1と同じ考え方)
    await deps.escalate.compact(history, signal).catch(() => {
      /* 圧縮失敗でも格上げは続行 */
    });
    history.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '(自動格上げ)実行が難航したため上位モデルに交代した。ここまでの経緯を踏まえ、残りのタスクを完遂して結果を要約せよ。',
        },
      ],
    });
    consecutiveFailures = 0;
    status = await runOnce(deps.escalate.provider);
  }

  const summary = extractSummary(history);
  const finalStatus: SubAgentUpdate['status'] =
    status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'error';
  deps.onUpdate?.({
    id,
    task: taskLabel,
    mode: 'work',
    status: finalStatus,
    startedAt,
    summaryTail: summary.slice(-200),
    ...(escalated ? { escalated: true } : {}),
  });
  if (status === 'cancelled') return '(サブエージェントはキャンセルされた)';
  if (summary === '') return `(サブエージェント #${id} は要約を返さなかった。status: ${status})`;
  return status === 'done' ? summary : `${summary}\n(status: ${status})`;
}
