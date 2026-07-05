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
  const emitUpdate = (partial: Partial<SubAgentUpdate>): void =>
    deps.onUpdate?.({ id, task: taskLabel, mode: 'work', status: 'running', ...partial });

  emitUpdate({});
  const status = await runAgentLoop(
    {
      provider: deps.provider,
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
        return deps.executeTool(name, input, { ...ctx, subAgentId: id });
      },
      emit: () => {}, // 子の生イベントは親のチャットへ流さない(進行は onUpdate で通知)
      systemPrompt: WORK_PROMPT(id),
      cwd: deps.cwd,
      maxTurns: deps.maxTurns ?? WORK_SUBAGENT_DEFAULT_MAX_TURNS,
    },
    `subagent-${id}`,
    history,
    signal,
  );

  const summary = extractSummary(history);
  const finalStatus: SubAgentUpdate['status'] =
    status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'error';
  deps.onUpdate?.({
    id,
    task: taskLabel,
    mode: 'work',
    status: finalStatus,
    summaryTail: summary.slice(-200),
  });
  if (status === 'cancelled') return '(サブエージェントはキャンセルされた)';
  if (summary === '') return `(サブエージェント #${id} は要約を返さなかった。status: ${status})`;
  return status === 'done' ? summary : `${summary}\n(status: ${status})`;
}
