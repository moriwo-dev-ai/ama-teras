import type { ChatMessage, LLMProvider } from '../providers/types';
import type { ToolContext, ToolPlugin } from '../tools/types';
import { runAgentLoop } from './loop';

/**
 * サブエージェント(M8-4)。調査タスクを別コンテキスト(独立した history)の
 * 子エージェントに委譲する。子は読み取り専用ツール(safe)のみ使え、書き込み/実行は
 * できない。子の生ログ(ツール往復)は親履歴に入らず、最後の要約テキストだけを返す。
 * → 親履歴の肥大を防ぎつつ、重い探索を別コンテキストへ逃がす。
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
 * plan(M12-2)は risk:'safe' だが write アクションで計画ファイルを書き換えられるため除外する
 */
function isReadOnlyDelegable(p: ToolPlugin): boolean {
  return (
    p.risk === 'safe' &&
    p.name !== 'request_capability' &&
    p.name !== 'dispatch_agent' &&
    p.name !== 'plan'
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
