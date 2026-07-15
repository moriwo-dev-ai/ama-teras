import type { ToolPlugin, ToolContext, ToolResult } from '../types';

// slugify: 文字列をURLスラッグに変換する読み取り専用ツール。
// 変換規則:
//   1. Unicode NFKD 正規化でアクセント記号などを分解し、結合文字(ダイアクリティカルマーク)を除去
//      (例: 'Héllo' → 'Hello')
//   2. 小文字化
//   3. ASCII 英数字 [a-z0-9] 以外の文字はすべてハイフンに置換
//   4. 連続するハイフンは1つに圧縮
//   5. 先頭・末尾のハイフンを除去
// 例: 'Hello, World! 2026' → 'hello-world-2026'

const MAX_TEXT_LENGTH = 100_000;

interface SlugifyInput {
  text: string;
}

function parseInput(input: unknown): { value: SlugifyInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }
  const obj = input as { [key: string]: unknown };

  const text = obj.text;
  if (typeof text !== 'string') {
    return { error: 'text は文字列で指定すること' };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return { error: `text が長すぎる(最大 ${MAX_TEXT_LENGTH} 文字)` };
  }

  return { value: { text } };
}

/** 文字列をURLスラッグへ変換する(テスト用に export) */
export function toSlug(text: string): string {
  // NFKD 正規化 → 結合文字(U+0300〜U+036F ほか)を除去してアクセントを基底文字に落とす
  const decomposed = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return decomposed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // 英数字以外の連続はハイフン1つに(圧縮も同時に行う)
    .replace(/^-+|-+$/g, ''); // 前後のハイフンを除去
}

export default {
  name: 'slugify',
  description:
    '文字列をURLスラッグに変換する。小文字化し、英数字以外はハイフンに置換、連続ハイフンは1つに圧縮し、前後のハイフンを除去する。アクセント付きラテン文字は基底文字に変換する(例: "Hello, World! 2026" → "hello-world-2026")。結果を {slug} のJSONで返す。',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'スラッグへ変換する文字列',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }
    const slug = toSlug(parsed.value.text);
    return { content: JSON.stringify({ slug }) };
  },
} satisfies ToolPlugin;
