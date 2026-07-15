import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/** 数値を小数2桁までに丸めてSVG座標文字列にする(浮動小数の長い尾を防ぐ) */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

const MS_PER_DAY = 86400000;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' を UTC エポックms に変換する。書式不正・実在しない日付は null */
function parseDateUtc(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const epoch = Date.UTC(y, mo - 1, d);
  const dt = new Date(epoch);
  // 2026-02-30 のような繰り上がりを検出する
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return epoch;
}

/** UTC エポックms を 'YYYY-MM-DD' に戻す */
function toDateString(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

type ParsedData = {
  /** 日付文字列 → 値(重複日付は合算) */
  values: Map<string, number>;
  minEpoch: number;
  maxEpoch: number;
  maxValue: number;
};

function parseData(raw: unknown): ParsedData | string {
  if (!Array.isArray(raw)) {
    return 'data は {date, value} オブジェクトの配列で指定すること';
  }
  if (raw.length === 0) {
    return 'data は1件以上指定すること';
  }
  const values = new Map<string, number>();
  let minEpoch = Number.POSITIVE_INFINITY;
  let maxEpoch = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return `data[${i}] は {date, value} のオブジェクトで指定すること`;
    }
    const { date, value } = item as { date?: unknown; value?: unknown };
    if (typeof date !== 'string') {
      return `data[${i}].date は 'YYYY-MM-DD' 形式の文字列で指定すること`;
    }
    const epoch = parseDateUtc(date);
    if (epoch === null) {
      return `data[${i}].date が不正: "${date}"('YYYY-MM-DD' 形式の実在する日付で指定すること)`;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `data[${i}].value は有限の数値で指定すること`;
    }
    if (value < 0) {
      return `data[${i}].value は0以上で指定すること(指定値: ${value})`;
    }
    const key = toDateString(epoch);
    values.set(key, (values.get(key) ?? 0) + value);
    if (epoch < minEpoch) minEpoch = epoch;
    if (epoch > maxEpoch) maxEpoch = epoch;
  }
  let maxValue = 0;
  for (const v of values.values()) {
    if (v > maxValue) maxValue = v;
  }
  return { values, minEpoch, maxEpoch, maxValue };
}

/** 値を0〜4の5段階に量子化する(0は空、1〜4は濃度) */
function levelOf(value: number, maxValue: number): number {
  if (value <= 0 || maxValue <= 0) return 0;
  return Math.min(4, Math.ceil((value / maxValue) * 4));
}

/** 段階1〜4の fill-opacity(段階0は薄いグレー塗り) */
const LEVEL_OPACITY = [0, 0.25, 0.5, 0.75, 1] as const;
const EMPTY_FILL = '#ebedf0';

export default {
  name: 'calendar_heatmap_svg',
  description:
    'GitHubのコントリビューショングラフ風のカレンダーヒートマップSVGを生成する。' +
    '{date, value} の配列を受け取り、週を列・曜日(日曜始まり)を行にした角丸マスのグリッドで描き、' +
    '値の大きさで5段階(空+4濃度)に色を濃くする。月ラベル・曜日ラベル・Less/Moreの凡例付き。' +
    '重複した日付の値は合算する。color(基調色)・cell(マスのサイズpx)を指定できる。' +
    '外部依存なしの純粋計算で、結果は {svg} のJSON(<svg>...</svg> 文字列)として返す。',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        description: 'ヒートマップのデータ(1件以上)。date は YYYY-MM-DD、value は0以上の数値',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: '日付(YYYY-MM-DD)' },
            value: { type: 'number', description: 'その日の値(0以上)' },
          },
          required: ['date', 'value'],
        },
      },
      color: {
        type: 'string',
        description: 'マスの基調色(例 "#39d353" / "seagreen"。既定 "#39d353"。値が大きいほど不透明に濃くなる)',
      },
      cell: { type: 'integer', description: 'マス1辺のサイズpx(既定 12、最小4・最大40)' },
    },
    required: ['data'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { data, color, cell } = (input ?? {}) as {
      data?: unknown;
      color?: unknown;
      cell?: unknown;
    };

    if (color !== undefined && typeof color !== 'string') {
      return { content: 'color は文字列で指定すること', isError: true };
    }
    // 属性値に " や < を含む色指定はSVG構造を壊すため拒否する
    const baseColor = color ?? '#39d353';
    if (/[<>"']/.test(baseColor)) {
      return { content: 'color に <>"\' は使えない', isError: true };
    }

    let cellSize = 12;
    if (cell !== undefined) {
      if (typeof cell !== 'number' || !Number.isFinite(cell)) {
        return { content: 'cell は数値で指定すること', isError: true };
      }
      const n = Math.floor(cell);
      if (n < 4 || n > 40) {
        return { content: `cell は 4〜40 の範囲で指定すること(指定値: ${cell})`, isError: true };
      }
      cellSize = n;
    }

    const parsed = parseData(data);
    if (typeof parsed === 'string') return { content: parsed, isError: true };
    const { values, minEpoch, maxEpoch, maxValue } = parsed;

    // 期間が長すぎるとSVGが巨大化するため上限を設ける(約10年)
    const totalDays = Math.round((maxEpoch - minEpoch) / MS_PER_DAY) + 1;
    if (totalDays > 3700) {
      return {
        content: `期間が長すぎる(${totalDays}日)。データの日付範囲は3700日以内にすること`,
        isError: true,
      };
    }

    // レイアウト定数
    const gap = Math.max(1, Math.round(cellSize * 0.25));
    const step = cellSize + gap;
    const fontSize = Math.max(8, Math.round(cellSize * 0.75));
    const leftMargin = Math.round(fontSize * 3);
    const topMargin = fontSize + gap * 2;
    const radius = Math.max(1, Math.round(cellSize / 6));

    // 最初のマスは minEpoch を含む週の日曜日
    const startDow = new Date(minEpoch).getUTCDay();
    const gridStart = minEpoch - startDow * MS_PER_DAY;
    const gridDays = Math.round((maxEpoch - gridStart) / MS_PER_DAY) + 1;
    const weeks = Math.ceil(gridDays / 7);

    const gridW = weeks * step - gap;
    const legendH = cellSize + gap * 3;
    const width = leftMargin + gridW + gap * 2;
    const height = topMargin + 7 * step - gap + gap * 2 + legendH;

    const xOfWeek = (w: number): number => leftMargin + w * step;
    const yOfRow = (r: number): number => topMargin + r * step;

    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">`,
    );

    // 曜日ラベル(GitHub風に Mon / Wed / Fri のみ)
    const dowLabels: Array<[number, string]> = [
      [1, 'Mon'],
      [3, 'Wed'],
      [5, 'Fri'],
    ];
    for (const [row, label] of dowLabels) {
      const y = yOfRow(row) + cellSize / 2 + fontSize * 0.35;
      parts.push(
        `<text x="${fmt(leftMargin - gap * 2)}" y="${fmt(y)}" font-size="${fontSize}" fill="#57606a" text-anchor="end">${label}</text>`,
      );
    }

    // 日マスと月ラベル
    let prevMonth = -1;
    for (let w = 0; w < weeks; w++) {
      let firstInRangeMonth = -1;
      for (let r = 0; r < 7; r++) {
        const epoch = gridStart + (w * 7 + r) * MS_PER_DAY;
        if (epoch < minEpoch || epoch > maxEpoch) continue;
        if (firstInRangeMonth < 0) firstInRangeMonth = new Date(epoch).getUTCMonth();
        const key = toDateString(epoch);
        const value = values.get(key) ?? 0;
        const level = levelOf(value, maxValue);
        const opacity = LEVEL_OPACITY[level] ?? 0;
        const fill = level === 0 ? EMPTY_FILL : baseColor;
        const opacityAttr = level === 0 ? '' : ` fill-opacity="${fmt(opacity)}"`;
        parts.push(
          `<rect class="day" data-date="${key}" data-level="${level}" x="${fmt(xOfWeek(w))}" y="${fmt(yOfRow(r))}" width="${cellSize}" height="${cellSize}" rx="${radius}" fill="${fill}"${opacityAttr}><title>${key}: ${fmt(value)}</title></rect>`,
        );
      }
      // その列の先頭日の月が前列と変わったら月ラベルを付ける
      if (firstInRangeMonth >= 0 && firstInRangeMonth !== prevMonth) {
        const name = MONTH_NAMES[firstInRangeMonth];
        if (name !== undefined) {
          parts.push(
            `<text x="${fmt(xOfWeek(w))}" y="${fmt(topMargin - gap)}" font-size="${fontSize}" fill="#57606a">${name}</text>`,
          );
        }
        prevMonth = firstInRangeMonth;
      }
    }

    // 凡例(Less → More の5段階)
    const legendY = topMargin + 7 * step - gap + gap * 2;
    const legendTextY = legendY + cellSize / 2 + fontSize * 0.35;
    let legendX = leftMargin;
    parts.push(
      `<text x="${fmt(legendX)}" y="${fmt(legendTextY)}" font-size="${fontSize}" fill="#57606a">Less</text>`,
    );
    legendX += Math.round(fontSize * 2.4) + gap;
    for (let level = 0; level <= 4; level++) {
      const opacity = LEVEL_OPACITY[level] ?? 0;
      const fill = level === 0 ? EMPTY_FILL : baseColor;
      const opacityAttr = level === 0 ? '' : ` fill-opacity="${fmt(opacity)}"`;
      parts.push(
        `<rect class="legend" data-level="${level}" x="${fmt(legendX)}" y="${fmt(legendY)}" width="${cellSize}" height="${cellSize}" rx="${radius}" fill="${fill}"${opacityAttr}/>`,
      );
      legendX += step;
    }
    parts.push(
      `<text x="${fmt(legendX + gap)}" y="${fmt(legendTextY)}" font-size="${fontSize}" fill="#57606a">More</text>`,
    );

    parts.push('</svg>');
    return { content: JSON.stringify({ svg: parts.join('') }) };
  },
} satisfies ToolPlugin;
