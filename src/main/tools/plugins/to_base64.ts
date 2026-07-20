import type { ToolPlugin, ToolContext, ToolResult } from '../types';

// to_base64: 文字列を UTF-8 バイト列とみなして Base64 に変換する読み取り専用ツール。
// decode=true で逆変換もできる。
// 変換規則:
//   - encode: UTF-8 バイト列 → Base64(既定)。urlSafe=true で URL安全形式
//     (+ → -、/ → _、末尾の = を除去)
//   - decode: Base64 → UTF-8 文字列。標準形式・URL安全形式のどちらも受ける
// 例: 'こんにちは' → '44GT44KT44Gr44Gh44Gv'

const MAX_TEXT_LENGTH = 1_000_000;

interface ToBase64Input {
  text: string;
  decode: boolean;
  urlSafe: boolean;
}

function parseInput(input: unknown): { value: ToBase64Input } | { error: string } {
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

  const decode = obj.decode;
  if (decode !== undefined && typeof decode !== 'boolean') {
    return { error: 'decode は真偽値で指定すること' };
  }
  const urlSafe = obj.urlSafe;
  if (urlSafe !== undefined && typeof urlSafe !== 'boolean') {
    return { error: 'urlSafe は真偽値で指定すること' };
  }

  return { value: { text, decode: decode === true, urlSafe: urlSafe === true } };
}

/** 文字列を Base64 へ(テスト用に export) */
export function encodeBase64(text: string, urlSafe = false): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  // URL安全形式は RFC 4648 §5。パディングはURLに載せると邪魔なので落とす
  return urlSafe ? b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') : b64;
}

/** Base64 を文字列へ(標準・URL安全のどちらも受ける。テスト用に export) */
export function decodeBase64(b64: string): { text: string } | { error: string } {
  const normalized = b64.trim().replaceAll('-', '+').replaceAll('_', '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return { error: 'Base64として解釈できない文字が含まれている' };
  }
  const buf = Buffer.from(normalized, 'base64');
  // Buffer は不正な入力を黙って捨てるので、往復させて壊れていないか確かめる
  // (ここを見ないと「復号できた」と嘘をつくことになる)
  if (buf.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    return { error: 'Base64として不正(長さが合わないか、余分な文字がある)' };
  }
  return { text: buf.toString('utf8') };
}

export default {
  name: 'to_base64',
  description:
    '文字列をUTF-8バイト列としてBase64に変換する。urlSafe=true でURL安全形式(+→-、/→_、末尾の=を除去)にできる。decode=true を渡すと逆にBase64を文字列へ復号し、標準形式・URL安全形式のどちらも受け付ける。結果を {result} のJSONで返す。',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '変換する文字列(decode=true のときは Base64 文字列)',
      },
      decode: {
        type: 'boolean',
        description: 'true なら Base64 から文字列へ復号する(既定 false)',
      },
      urlSafe: {
        type: 'boolean',
        description: 'true なら URL安全な Base64 を出力する(既定 false。decode時は無視)',
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
    const { text, decode, urlSafe } = parsed.value;
    if (decode) {
      const r = decodeBase64(text);
      if ('error' in r) return { content: r.error, isError: true };
      return { content: JSON.stringify({ result: r.text }) };
    }
    return { content: JSON.stringify({ result: encodeBase64(text, urlSafe) }) };
  },
} satisfies ToolPlugin;
