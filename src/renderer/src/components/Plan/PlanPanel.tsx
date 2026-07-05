import { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '../../stores/chat';
import { parsePlanProgress } from './planParse';

/**
 * M12-2: 計画パネル(読み取り専用)。MYCODEX_PLAN.md のチェックリストを進捗表示する。
 * 編集はエージェント(plan ツール)の仕事。ターン完了ごとに自動更新する。
 */
export function PlanPanel(): JSX.Element {
  const [content, setContent] = useState('');
  const busy = useChatStore((s) => s.activeSessionId !== null);

  const refresh = useCallback(async () => {
    try {
      setContent(await window.api.planGet());
    } catch {
      // 取得失敗は表示だけの問題(次の更新で回復)
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // ターン完了(busy→false)のたびに最新化
  useEffect(() => {
    if (!busy) void refresh();
  }, [busy, refresh]);

  const progress = parsePlanProgress(content);

  return (
    <div className="max-h-64 overflow-y-auto border-t border-zinc-700 bg-zinc-900 px-4 py-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="font-semibold text-zinc-300">計画(MYCODEX_PLAN.md)</h3>
        {progress.total > 0 && (
          <span className="text-zinc-400">
            {progress.done}/{progress.total} 完了
          </span>
        )}
        <button
          className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-400 hover:bg-zinc-800"
          onClick={() => void refresh()}
        >
          更新
        </button>
      </div>
      {content.trim() === '' ? (
        <p className="text-zinc-500">
          計画はまだ無い(複数ステップの指示を出すとエージェントが plan ツールで作成する)
        </p>
      ) : progress.total > 0 ? (
        <ul className="space-y-0.5">
          {progress.items.map((item, i) => (
            <li key={i} className={item.done ? 'text-zinc-500 line-through' : 'text-zinc-300'}>
              {/* 完了への変化時だけ anim-check が付与されてポップする */}
              <span className={item.done ? 'anim-check' : ''}>{item.done ? '☑' : '☐'}</span> {item.text}
            </li>
          ))}
        </ul>
      ) : (
        <pre className="whitespace-pre-wrap text-zinc-400">{content}</pre>
      )}
    </div>
  );
}
