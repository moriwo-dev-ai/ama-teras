import { useSubAgentStore } from '../../stores/subagents';

const STATUS_LABEL: Record<string, string> = {
  running: '実行中',
  done: '完了',
  error: 'エラー',
  cancelled: 'キャンセル',
};

const STATUS_CLASS: Record<string, string> = {
  running: 'text-blue-300',
  done: 'text-emerald-300',
  error: 'text-red-300',
  cancelled: 'text-zinc-400',
};

/** M12-3: 並列サブエージェントの進行ビュー(進化パネルと同系のレイアウト) */
export function SubAgentPanel(): JSX.Element {
  const { agents, clear } = useSubAgentStore();

  return (
    <div className="max-h-64 overflow-y-auto border-t border-zinc-700 bg-zinc-900 px-4 py-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-semibold text-zinc-300">サブエージェント</h3>
        <button
          className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:bg-zinc-800"
          onClick={clear}
        >
          クリア
        </button>
      </div>
      {agents.length === 0 ? (
        <p className="text-zinc-500">
          実行履歴なし(dispatch_agent の mode:"work" / parallel で子エージェントが起動する)
        </p>
      ) : (
        <ul className="space-y-1">
          {agents.map((a) => (
            <li key={a.id} className="rounded border border-zinc-800 px-2 py-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-zinc-400">#{a.id}</span>
                <span className="rounded bg-zinc-800 px-1 text-zinc-400">{a.mode}</span>
                <span className={STATUS_CLASS[a.status] ?? 'text-zinc-300'}>
                  {STATUS_LABEL[a.status] ?? a.status}
                </span>
                {a.status === 'running' && a.currentTool && (
                  <span className="font-mono text-zinc-500">⚙ {a.currentTool}</span>
                )}
              </div>
              <p className="truncate text-zinc-300">{a.task}</p>
              {a.summaryTail && a.status !== 'running' && (
                <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-zinc-500">{a.summaryTail}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
