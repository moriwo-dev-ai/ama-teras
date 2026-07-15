import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/** SVGテキストノード・属性値用のXMLエスケープ */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 数値を小数2桁までに丸めてSVG座標文字列にする(浮動小数の長い尾を防ぐ) */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 値ラベル表示: 整数はそのまま、小数は最大2桁 */
function fmtValue(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

interface BarDatum {
  label: string;
  value: number;
}

function parseData(raw: unknown): BarDatum[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'data は {label, value} の空でない配列で指定すること';
  }
  const out: BarDatum[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (typeof item !== 'object' || item === null) {
      return `data[${i}] がオブジェクトではない`;
    }
    const { label, value } = item as { label?: unknown; value?: unknown };
    if (typeof label !== 'string') {
      return `data[${i}].label は文字列で指定すること`;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `data[${i}].value は有限の数値で指定すること`;
    }
    if (value < 0) {
      return `data[${i}].value が負(${value})。このツールは0以上の値のみ対応`;
    }
    out.push({ label, value });
  }
  return out;
}

export default {
  name: 'svg_bar_chart',
  description:
    '数値データからSVG棒グラフを生成する。各バーの高さは最大値でスケールされ、' +
    'バーごとのラベル・値テキスト、Y軸グリッド線(目盛り値付き)、タイトルを描画する。' +
    'color(バー色)、width/height(キャンバスサイズ)も指定できる。' +
    '外部依存なしの純粋計算で、結果は {svg} のJSON(<svg>...</svg> 文字列)として返す。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'グラフ上部に表示するタイトル(省略可)' },
      width: { type: 'integer', description: 'SVG全体の幅px(既定 640、最小120・最大4096)' },
      height: { type: 'integer', description: 'SVG全体の高さpx(既定 400、最小120・最大4096)' },
      data: {
        type: 'array',
        description: '棒グラフのデータ配列(1件以上)。value は0以上の数値',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'バーのラベル' },
            value: { type: 'number', description: 'バーの値(0以上)' },
          },
          required: ['label', 'value'],
        },
      },
      color: { type: 'string', description: 'バーの塗り色(例 "#4e79a7" / "steelblue"。既定 "#4e79a7")' },
    },
    required: ['data'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { title, width, height, data, color } = (input ?? {}) as {
      title?: unknown;
      width?: unknown;
      height?: unknown;
      data?: unknown;
      color?: unknown;
    };

    if (title !== undefined && typeof title !== 'string') {
      return { content: 'title は文字列で指定すること', isError: true };
    }
    const checkSize = (v: unknown, name: string, def: number): number | string => {
      if (v === undefined) return def;
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${name} は数値で指定すること`;
      const n = Math.floor(v);
      if (n < 120 || n > 4096) return `${name} は 120〜4096 の範囲で指定すること(指定値: ${v})`;
      return n;
    };
    const w = checkSize(width, 'width', 640);
    if (typeof w === 'string') return { content: w, isError: true };
    const h = checkSize(height, 'height', 400);
    if (typeof h === 'string') return { content: h, isError: true };
    if (color !== undefined && typeof color !== 'string') {
      return { content: 'color は文字列で指定すること', isError: true };
    }
    // 属性値に " や < を含む色指定はSVG構造を壊すため拒否する
    const barColor = color ?? '#4e79a7';
    if (/[<>"']/.test(barColor)) {
      return { content: 'color に <>"\' は使えない', isError: true };
    }

    const parsed = parseData(data);
    if (typeof parsed === 'string') return { content: parsed, isError: true };

    // レイアウト
    const marginTop = title !== undefined && title !== '' ? 44 : 24;
    const marginBottom = 40;
    const marginLeft = 52;
    const marginRight = 16;
    const plotW = w - marginLeft - marginRight;
    const plotH = h - marginTop - marginBottom;
    if (plotW <= 0 || plotH <= 0) {
      return { content: 'width/height が小さすぎて描画領域を確保できない', isError: true };
    }

    const maxValue = Math.max(...parsed.map((d) => d.value));
    const scale = maxValue > 0 ? plotH / maxValue : 0;
    const baselineY = marginTop + plotH;

    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="sans-serif">`,
    );
    parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>`);

    // タイトル
    if (title !== undefined && title !== '') {
      parts.push(
        `<text x="${fmt(w / 2)}" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="#333">${escapeXml(title)}</text>`,
      );
    }

    // Y軸グリッド線(0〜max を4分割 = 5本)
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const value = (maxValue * i) / gridSteps;
      const y = baselineY - value * scale;
      parts.push(
        `<line x1="${marginLeft}" y1="${fmt(y)}" x2="${w - marginRight}" y2="${fmt(y)}" stroke="#dddddd" stroke-width="1"/>`,
      );
      parts.push(
        `<text x="${marginLeft - 6}" y="${fmt(y + 4)}" text-anchor="end" font-size="11" fill="#666">${fmtValue(value)}</text>`,
      );
    }

    // バー(スロット幅の70%をバー、残りを間隔に)
    const n = parsed.length;
    const slotW = plotW / n;
    const barW = slotW * 0.7;
    for (let i = 0; i < n; i++) {
      const d = parsed[i];
      if (d === undefined) continue; // noUncheckedIndexedAccess ガード(範囲内なので実際は通らない)
      const barH = d.value * scale;
      const x = marginLeft + slotW * i + (slotW - barW) / 2;
      const y = baselineY - barH;
      const cx = x + barW / 2;
      parts.push(
        `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(barW)}" height="${fmt(barH)}" fill="${barColor}"/>`,
      );
      // 値テキスト(バーの上)
      parts.push(
        `<text x="${fmt(cx)}" y="${fmt(y - 5)}" text-anchor="middle" font-size="11" fill="#333">${fmtValue(d.value)}</text>`,
      );
      // ラベル(ベースラインの下)
      parts.push(
        `<text x="${fmt(cx)}" y="${fmt(baselineY + 16)}" text-anchor="middle" font-size="12" fill="#333">${escapeXml(d.label)}</text>`,
      );
    }

    // X軸線
    parts.push(
      `<line x1="${marginLeft}" y1="${fmt(baselineY)}" x2="${w - marginRight}" y2="${fmt(baselineY)}" stroke="#333333" stroke-width="1"/>`,
    );

    parts.push('</svg>');
    return { content: JSON.stringify({ svg: parts.join('') }) };
  },
} satisfies ToolPlugin;
