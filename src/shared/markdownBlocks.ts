/**
 * M16-3: markdown本文をテキスト/コードブロックへ分割する純関数。
 * remote-ui の軽量レンダリングが使用(desktopは react-markdown でレンダリング)。
 * ストリーミング途中の未クローズフェンスは「そこまでをコード」として扱う
 * (完成時に閉じフェンスが来れば確定する)。
 */

export type MarkdownSegment =
  | { type: 'text'; content: string }
  | { type: 'code'; lang: string | null; content: string };

const FENCE_RE = /^```([^\s`]*)[^\n]*$/;

export function splitMarkdownSegments(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const lines = markdown.split('\n');
  let textBuf: string[] = [];
  let codeBuf: string[] | null = null;
  let codeLang: string | null = null;

  const flushText = (): void => {
    if (textBuf.length > 0) {
      const content = textBuf.join('\n');
      if (content !== '') segments.push({ type: 'text', content });
      textBuf = [];
    }
  };

  for (const line of lines) {
    if (codeBuf === null) {
      const m = FENCE_RE.exec(line);
      if (m) {
        flushText();
        codeBuf = [];
        codeLang = m[1] === '' ? null : (m[1] ?? null);
        continue;
      }
      textBuf.push(line);
    } else {
      if (/^```\s*$/.test(line)) {
        segments.push({ type: 'code', lang: codeLang, content: codeBuf.join('\n') });
        codeBuf = null;
        codeLang = null;
        continue;
      }
      codeBuf.push(line);
    }
  }
  if (codeBuf !== null) {
    // 未クローズ(ストリーミング途中)もコードとして表示する
    segments.push({ type: 'code', lang: codeLang, content: codeBuf.join('\n') });
  } else {
    flushText();
  }
  return segments;
}

/** コードブロックだけを取り出す(テスト・検索用) */
export function listCodeBlocks(markdown: string): { lang: string | null; code: string }[] {
  return splitMarkdownSegments(markdown)
    .filter((s): s is Extract<MarkdownSegment, { type: 'code' }> => s.type === 'code')
    .map((s) => ({ lang: s.lang, code: s.content }));
}
