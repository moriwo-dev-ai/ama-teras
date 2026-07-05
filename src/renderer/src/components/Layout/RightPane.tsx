import { usePreviewStore } from '../../stores/preview';
import { FilePreview } from './FilePreview';

/**
 * M15-3: 右ペイン。ファイルプレビューを表示(M15-4 で環境ウィジェットとタブ集約が入る)。
 */
export function RightPane(): JSX.Element {
  const hasPreview = usePreviewStore((s) => s.result !== null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-300">
        コンテキスト
      </div>
      {hasPreview ? (
        <FilePreview />
      ) : (
        <div className="flex-1 overflow-y-auto p-3 text-xs text-zinc-500">
          チャット内のファイルパス(ツールカードの 📄 や本文中のパス)をクリックすると
          ここにプレビューが表示される。環境ウィジェット/パネルタブは M15-4 で追加
        </div>
      )}
    </div>
  );
}
