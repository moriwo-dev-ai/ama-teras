/**
 * M15-1: 左ペイン(骨格)。M15-2 でプロジェクト×セッションツリー・検索が入る。
 */
export function LeftPane(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-300">
        プロジェクト
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-xs text-zinc-500">
        セッションツリーは M15-2 で実装(現状はチャット上部のドロップダウンから切替)
      </div>
    </div>
  );
}
