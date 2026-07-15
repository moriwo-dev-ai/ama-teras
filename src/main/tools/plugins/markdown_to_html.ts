import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * Markdownを最小限のHTMLへ変換するツール。
 * 対応構文: 見出し(#〜######)、太字**、斜体*、インラインコード`、リンク[t](u)、
 * 順序なしリスト(-)、順序付きリスト(1.)、コードブロック(```)、段落。
 * 外部依存なしの純粋計算。& < > " はHTMLエスケープする。
 */

interface MarkdownToHtmlInput {
  markdown: string;
}

const MAX_INPUT_CHARS = 1_000_000;

function isInput(value: unknown): value is MarkdownToHtmlInput {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { [key: string]: unknown };
  return typeof v.markdown === 'string';
}

/** & < > " をエスケープ(& を最初に処理して二重エスケープを防ぐ) */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** リンク・太字・斜体を処理する(インラインコードの外側のみで呼ばれる) */
function renderEmphasis(escaped: string): string {
  let out = escaped;
  // リンク: [text](url)。text 内の太字/斜体は後段の置換で処理される
  out = out.replace(/\[([^\]]*)\]\(([^)\s]*)\)/g, (_m, text: string, url: string) => {
    return `<a href="${url}">${text}</a>`;
  });
  // 太字(**...**)を先に、斜体(*...*)を後に
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return out;
}

/** インライン要素をHTML化する。インラインコード内では他の装飾を適用しない */
function renderInline(raw: string): string {
  const escaped = escapeHtml(raw);
  const parts: string[] = [];
  const codeRe = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(escaped)) !== null) {
    parts.push(renderEmphasis(escaped.slice(last, m.index)));
    parts.push(`<code>${m[1] ?? ''}</code>`);
    last = m.index + m[0].length;
  }
  parts.push(renderEmphasis(escaped.slice(last)));
  return parts.join('');
}

function convert(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const blocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // 空行はスキップ(ブロック区切り)
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // コードブロック(``` 〜 ```)。中身はエスケープのみで装飾しない
    if (/^```/.test(line.trim())) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test((lines[i] ?? '').trim())) {
        code.push(lines[i] ?? '');
        i += 1;
      }
      i += 1; // 閉じフェンス(EOFで閉じていなくても許容)
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    // 見出し(# 〜 ######)
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? '#').length;
      blocks.push(`<h${level}>${renderInline((heading[2] ?? '').trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // 順序なしリスト(- item)
    if (/^\s*-\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const li = /^\s*-\s+(.*)$/.exec(lines[i] ?? '');
        if (!li) break;
        items.push(`<li>${renderInline((li[1] ?? '').trim())}</li>`);
        i += 1;
      }
      blocks.push(`<ul>\n${items.join('\n')}\n</ul>`);
      continue;
    }

    // 順序付きリスト(1. item)
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const li = /^\s*\d+\.\s+(.*)$/.exec(lines[i] ?? '');
        if (!li) break;
        items.push(`<li>${renderInline((li[1] ?? '').trim())}</li>`);
        i += 1;
      }
      blocks.push(`<ol>\n${items.join('\n')}\n</ol>`);
      continue;
    }

    // 段落: 空行または他のブロック開始まで連結
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      if (
        cur.trim() === '' ||
        /^```/.test(cur.trim()) ||
        /^#{1,6}\s+/.test(cur) ||
        /^\s*-\s+/.test(cur) ||
        /^\s*\d+\.\s+/.test(cur)
      ) {
        break;
      }
      para.push(cur.trim());
      i += 1;
    }
    blocks.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return blocks.join('\n');
}

const plugin = {
  name: 'markdown_to_html',
  description:
    'Markdownを最小限のHTMLへ変換する。見出し(#〜######)、太字**、斜体*、インラインコード`、リンク[t](u)、順序なしリスト(-)、順序付きリスト(1.)、コードブロック(```)、段落に対応し、& < > " はHTMLエスケープする。外部依存なしの純粋計算で、結果を {html} のJSONで返す。',
  risk: 'safe',
  tags: ['テキスト処理'],
  inputSchema: {
    type: 'object',
    properties: {
      markdown: {
        type: 'string',
        description: '変換するMarkdownテキスト',
      },
    },
    required: ['markdown'],
    additionalProperties: false,
  },
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    if (!isInput(input)) {
      return {
        content: 'Invalid input: 文字列フィールド "markdown" を持つオブジェクトを渡してください。',
        isError: true,
      };
    }
    if (input.markdown.length > MAX_INPUT_CHARS) {
      return {
        content: `入力が大きすぎます(${input.markdown.length}文字 > 上限${MAX_INPUT_CHARS}文字)。分割して変換してください。`,
        isError: true,
      };
    }
    const html = convert(input.markdown);
    return { content: JSON.stringify({ html }) };
  },
} satisfies ToolPlugin;

export default plugin;
