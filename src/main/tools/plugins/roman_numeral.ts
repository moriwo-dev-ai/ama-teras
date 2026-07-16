import type { ToolPlugin, ToolContext, ToolResult } from '../types';

// roman_numeral: 整数(1〜3999)をローマ数字の文字列へ変換する読み取り専用ツール。
// 変換規則:
//   標準的な減算記法(subtractive notation)を用いる。
//   例: 4 → 'IV', 9 → 'IX', 40 → 'XL', 90 → 'XC', 400 → 'CD', 900 → 'CM'
//   例: 2024 → 'MMXXIV', 3999 → 'MMMCMXCIX'

const MIN_VALUE = 1;
const MAX_VALUE = 3999;

interface RomanNumeralInput {
  n: number;
}

function parseInput(input: unknown): { value: RomanNumeralInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }
  const obj = input as { [key: string]: unknown };

  const n = obj.n;
  if (typeof n !== 'number' || Number.isNaN(n)) {
    return { error: 'n は数値で指定すること' };
  }
  if (!Number.isInteger(n)) {
    return { error: 'n は整数で指定すること' };
  }
  if (n < MIN_VALUE || n > MAX_VALUE) {
    return { error: `n は ${MIN_VALUE}〜${MAX_VALUE} の範囲で指定すること` };
  }

  return { value: { n } };
}

// 値の大きい順に並べた (数値, ローマ数字) の対応表。減算記法のペアも含む。
const ROMAN_TABLE: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** 整数(1〜3999)をローマ数字へ変換する(テスト用に export)。範囲外は RangeError を投げる */
export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n < MIN_VALUE || n > MAX_VALUE) {
    throw new RangeError(`toRoman: n は ${MIN_VALUE}〜${MAX_VALUE} の整数であること (received: ${n})`);
  }
  let remaining = n;
  let result = '';
  for (const [value, symbol] of ROMAN_TABLE) {
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }
  return result;
}

export default {
  name: 'roman_numeral',
  description:
    '整数(1〜3999)をローマ数字の文字列へ変換する。標準的な減算記法を用いる(例: {n: 2024} → {roman: "MMXXIV"})。結果を {roman} のJSONで返す。',
  inputSchema: {
    type: 'object',
    properties: {
      n: {
        type: 'number',
        description: `ローマ数字へ変換する整数(${MIN_VALUE}〜${MAX_VALUE})`,
      },
    },
    required: ['n'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }
    const roman = toRoman(parsed.value.n);
    return { content: JSON.stringify({ roman }) };
  },
} satisfies ToolPlugin;
