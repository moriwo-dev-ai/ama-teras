/**
 * M15-1: 右ペイン(骨格)。M15-3 でファイルプレビュー、M15-4 で環境ウィジェットと
 * パネルタブ集約が入る。
 */
export function RightPane(): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-300">
        コンテキスト
      </div>
      <div className="flex-1 overflow-y-auto p-3 text-xs text-zinc-500">
        ファイルプレビュー(M15-3)・環境ウィジェット/パネルタブ(M15-4)がここに入る
      </div>
    </div>
  );
}
