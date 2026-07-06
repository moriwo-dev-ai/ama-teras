import { usePreviewStore } from '../../stores/preview';
import { revealContextMenuHandler } from '../../stores/revealMenu';

// M15-3: 本文中のパスらしき文字列をクリック可能にする(実在チェックはプレビュー側)
export const PATH_RE =
  /(?:[A-Za-z]:[\\/])?[\w.-]+(?:[\\/][\w.-]+)+\.(?:tsx?|jsx?|mjs|cjs|json|md|markdown|css|html|py|txt|ya?ml|toml|csv)\b|[\w-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|markdown|css|html|py|txt|ya?ml|toml|csv)\b/g;

export function LinkifiedText({ text }: { text: string }): JSX.Element {
  const openPreview = usePreviewStore((s) => s.open);
  const parts: (string | { path: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(PATH_RE)) {
    if (m.index === undefined) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ path: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <span key={i}>{p}</span>
        ) : (
          <button
            key={i}
            className="cursor-pointer font-mono text-blue-300 underline decoration-dotted hover:text-blue-200"
            onClick={() => void openPreview(p.path)}
            onContextMenu={revealContextMenuHandler(p.path)}
          >
            {p.path}
          </button>
        ),
      )}
    </>
  );
}
