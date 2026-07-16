import type { ToolPlugin, ToolContext, ToolResult } from '../types';

// duration_format: 秒数を "1h 2m 3s" 形式の人間可読な文字列に変換する純粋計算ツール。
// - 0 は "0s"
// - 端数(小数秒)はミリ秒精度(小数第3位)まで保持し、末尾の0は省く(例: 1.5 → "1.5s")
// - 上位単位が存在する場合は下位単位を 0 でも表示する(例: 3600 → "1h 0m 0s")
// - 負数は先頭に "-" を付ける(例: -65 → "-1m 5s")
// ネットワーク・ファイルアクセスは一切行わない。

interface DurationFormatInput {
  seconds: number;
}

function parseInput(input: unknown): { value: DurationFormatInput } | { error: string } {
  if (input === null || typeof input !== 'object') {
    return { error: 'input はオブジェクトで指定すること' };
  }
  const obj = input as { [key: string]: unknown };

  const seconds = obj.seconds;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return { error: 'seconds は有限の数値で指定すること' };
  }

  return { value: { seconds } };
}

/** 秒の端数部をミリ秒精度で文字列化する(末尾の0と不要な小数点を削る) */
function formatSecondsPart(wholeSeconds: number, milliseconds: number): string {
  if (milliseconds === 0) return String(wholeSeconds);
  const fraction = String(milliseconds).padStart(3, '0').replace(/0+$/, '');
  return `${wholeSeconds}.${fraction}`;
}

/**
 * 秒数を "1h 2m 3s" 形式に整形する。
 * 浮動小数点誤差を避けるため、まず全体をミリ秒に丸めてから各単位へ分解する。
 */
export function formatDuration(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const totalMs = Math.round(Math.abs(seconds) * 1000);

  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const remainderMs = totalMs % 60_000;
  const wholeSeconds = Math.floor(remainderMs / 1000);
  const milliseconds = remainderMs % 1000;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${formatSecondsPart(wholeSeconds, milliseconds)}s`);

  return sign + parts.join(' ');
}

export default {
  name: 'duration_format',
  description:
    '秒数を "1h 2m 3s" 形式の文字列に変換する。0 は "0s"、小数秒はミリ秒精度で保持(例: 1.5 → "1.5s")、負数は先頭に "-" を付ける。入力 { seconds:number } / 出力 { text:string }。',
  inputSchema: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        description: '変換する秒数(0・小数・負数も可。有限の数値であること)',
      },
    },
    required: ['seconds'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const parsed = parseInput(input);
    if ('error' in parsed) {
      return { content: parsed.error, isError: true };
    }

    const text = formatDuration(parsed.value.seconds);
    return { content: JSON.stringify({ text }) };
  },
} satisfies ToolPlugin;
