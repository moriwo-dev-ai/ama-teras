import { Children, isValidElement, memo, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LinkifiedText } from './LinkifiedText';

/**
 * M16-3: アシスタント本文のmarkdownレンダリング。
 * コードブロックには言語ラベル+コピーボタンを付ける。
 * パスのリンク化(M15-3)は p / li のテキスト部分に対して維持する。
 */

function openExternalLink(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function CodeBlock({ lang, code }: { lang: string | null; code: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        /* クリップボード不可の環境では黙って何もしない(UI崩壊を避ける) */
      });
  };
  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-700 bg-zinc-950" data-codeblock>
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-2 py-0.5">
        <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">{lang ?? 'text'}</span>
        <button
          data-copy-code
          className="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          title="コードをコピー"
          onClick={copy}
        >
          {copied ? '✓ コピーしました' : '📋 コピー'}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre p-2 font-mono text-[12px] leading-snug text-zinc-300">{code}</pre>
    </div>
  );
}

/** 文字列の子要素だけをパスリンク化に通す(強調・リンク等の要素はそのまま) */
function linkify(children: ReactNode): ReactNode {
  return Children.map(children, (child) =>
    typeof child === 'string' ? <LinkifiedText text={child} /> : child,
  );
}

function MarkdownMessageInner({ text }: { text: string }): JSX.Element {
  return (
    <div
      className="text-sm leading-relaxed
        [&_a]:text-blue-400 [&_a]:underline
        [&_blockquote]:border-l-2 [&_blockquote]:border-zinc-600 [&_blockquote]:pl-2 [&_blockquote]:text-zinc-400
        [&_h1]:mt-2 [&_h1]:text-base [&_h1]:font-bold [&_h2]:mt-2 [&_h2]:text-sm [&_h2]:font-bold
        [&_h3]:mt-1.5 [&_h3]:text-sm [&_h3]:font-semibold
        [&_hr]:my-2 [&_hr]:border-zinc-700
        [&_ol]:list-decimal [&_ul]:list-disc
        [&_table]:my-2 [&_table]:border-collapse [&_td]:border [&_td]:border-zinc-600 [&_td]:px-2 [&_td]:py-0.5
        [&_th]:border [&_th]:border-zinc-600 [&_th]:bg-zinc-700 [&_th]:px-2 [&_th]:py-0.5"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // pre を CodeBlock に差し替える(インラインcodeは下の code が処理)
          pre: ({ children }) => {
            const child = Children.toArray(children)[0];
            if (isValidElement(child)) {
              const el = child as ReactElement<{ className?: string; children?: ReactNode }>;
              const raw = String(el.props.children ?? '').replace(/\n$/, '');
              const lang = /language-([\w+-]+)/.exec(el.props.className ?? '')?.[1] ?? null;
              return <CodeBlock lang={lang} code={raw} />;
            }
            return <pre>{children}</pre>;
          },
          code: ({ children }) => (
            <code className="rounded bg-zinc-700/70 px-1 font-mono text-[12px]">{children}</code>
          ),
          a: ({ href, children }) => {
            const isExternal = typeof href === 'string' && /^https?:\/\//i.test(href);
            return (
              <a
                href={href}
                target={isExternal ? '_blank' : undefined}
                rel={isExternal ? 'noopener noreferrer' : undefined}
                onClick={
                  isExternal
                    ? (e: MouseEvent<HTMLAnchorElement>) => {
                        e.preventDefault();
                        openExternalLink(href);
                      }
                    : undefined
                }
              >
                {children}
              </a>
            );
          },
          // whitespace-pre-wrap で従来どおり単改行を保持しつつ、パスリンク化も維持
          p: ({ children }) => <p className="my-1 whitespace-pre-wrap">{linkify(children)}</p>,
          li: ({ children }) => <li className="ml-4 whitespace-pre-wrap">{linkify(children)}</li>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** 完了済みメッセージの再レンダリングを避ける(ストリーミング中はtextが変わるので都度描画) */
export const MarkdownMessage = memo(MarkdownMessageInner);
