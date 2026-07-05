import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { usePreviewStore } from '../../stores/preview';

/**
 * M15-3: ファイルプレビュー本体(読み取り専用)。
 * .md はレンダリング、コード/テキストは等幅、画像はそのまま表示。
 */
export function FilePreview(): JSX.Element | null {
  const { result, requestedPath, refresh, close } = usePreviewStore();
  if (!result) return null;

  const name = (result.path ?? requestedPath ?? '').split(/[\\/]/).pop() ?? '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1.5 text-xs">
        <span className="truncate font-mono text-zinc-300" title={result.path ?? requestedPath ?? ''}>
          📄 {name}
        </span>
        <div className="ml-auto flex shrink-0 gap-1">
          <button
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
            onClick={() => void refresh()}
          >
            再読込
          </button>
          {result.ok && result.path && (
            <button
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
              onClick={() => void window.api.fileReveal(result.path!)}
            >
              フォルダで表示
            </button>
          )}
          <button
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800"
            onClick={close}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!result.ok && <p className="text-xs text-red-400">{result.message}</p>}
        {result.ok && result.kind === 'image' && result.dataUrl && (
          <img src={result.dataUrl} alt={name} className="max-w-full rounded border border-zinc-800" />
        )}
        {result.ok && result.kind === 'markdown' && result.content !== undefined && (
          <div
            className="text-sm leading-relaxed text-zinc-200
              [&_a]:text-blue-400 [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600 [&_blockquote]:pl-2
              [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px]
              [&_h1]:mt-3 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-bold
              [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:ml-4 [&_ol]:list-decimal
              [&_p]:my-1.5 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-zinc-900 [&_pre]:p-2
              [&_table]:my-2 [&_table]:border-collapse [&_td]:border [&_td]:border-zinc-700 [&_td]:px-2 [&_td]:py-0.5
              [&_th]:border [&_th]:border-zinc-700 [&_th]:bg-zinc-800 [&_th]:px-2 [&_th]:py-0.5 [&_ul]:list-disc"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.content}</ReactMarkdown>
          </div>
        )}
        {result.ok && result.kind === 'code' && result.content !== undefined && (
          <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-snug text-zinc-300">
            {result.content}
          </pre>
        )}
        {result.truncated && (
          <p className="mt-2 text-[10px] text-amber-400">…先頭1MBのみ表示(ファイルが大きいため切り詰め)</p>
        )}
      </div>
    </div>
  );
}
