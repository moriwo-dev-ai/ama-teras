import type { ToolPlugin, ToolContext, ToolResult } from '../types';

// ordinal_suffix: 整数を英語の序数(1st / 2nd / 3rd / 4th …)に変換する読み取り専用ツール。
// 規則:
//   1. 下2桁が 11〜13 のときは必ず 'th'(11th / 12th / 13th / 111th …)
//   2. それ以外は下1桁で決める: 1→st、2→nd、3→rd、それ以外→th
//   3. 負数は符号を保ったまま絶対値で判定する(-1 → -1st)
// 例: 1 → '1st' / 22 → '22nd' / 113 → '113th'

const MAX_ABS = Number.MAX_SAFE_INTEGER;

interface OrdinalSuffixInput {
  value: number;
}

function parseInput(input: unknown): { value: OrdinalSuffixInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }
  const obj = input as { [key: string]: unknown };

  const value = obj.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { error: 'value は有限の数値で指定すること' };
  }
  if (!Number.isInteger(value)) {
    return { error: 'value は整数で指定すること(序数は整数にしか定義できない)' };
  }
  if (Math.abs(value) > MAX_ABS) {
    return { error: 'value が大きすぎる(安全な整数の範囲を超えている)' };
  }

  return { value: { value } };
}

/** 整数に対応する英語の序数接尾辞を返す(テスト用に export) */
export function ordinalSuffixOf(value: number): string {
  const n = Math.abs(value);
  // 11〜13 は下1桁に関係なく th(11th, 12th, 13th)。100の位より上は影響しない
  const lastTwo = n % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

/** 整数を序数の文字列にする(テスト用に export) */
export function toOrdinal(value: number): string {
  return `${value}${ordinalSuffixOf(value)}`;
}

export default {
  name: 'ordinal_suffix',
  description:
    '整数を英語の序数に変換する(1→"1st"、2→"2nd"、3→"3rd"、4→"4th")。下2桁が11〜13の場合は必ず"th"になる規則(11th/12th/13th/111th)に対応し、負数は符号を保つ(-1→"-1st")。結果を {ordinal, suffix} のJSONで返す。',
  inputSchema: {
    type: 'object',
    properties: {
      value: {
        type: 'integer',
        description: '序数に変換する整数',
      },
    },
    required: ['value'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }
    const { value } = parsed.value;
    return { content: JSON.stringify({ ordinal: toOrdinal(value), suffix: ordinalSuffixOf(value) }) };
  },
} satisfies ToolPlugin;
