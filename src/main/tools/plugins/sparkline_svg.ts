import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/** 数値を小数2桁までに丸めてSVG座標文字列にする(浮動小数の長い尾を防ぐ) */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function parseData(raw: unknown): number[] | string {
  if (!Array.isArray(raw)) {
    return 'data は数値の配列で指定すること';
  }
  if (raw.length < 2) {
    return 'data は2点以上の数値配列で指定すること(折れ線には最低2点必要)';
  }
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const v: unknown = raw[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return `data[${i}] は有限の数値で指定すること`;
    }
    out.push(v);
  }
  return out;
}

export default {
  name: 'sparkline_svg',
  description:
    '数値の配列から折れ線スパークラインのSVGを生成する。値を幅・高さに正規化して polyline で描き、' +
    '最小値・最大値の点に円マーカーを付ける。color(線色)・strokeWidth(線の太さ)・' +
    'width/height(キャンバスサイズ)を指定できる。外部依存なしの純粋計算で、' +
    '結果は {svg} のJSON(<svg>...</svg> 文字列)として返す。',
  inputSchema: {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        description: 'スパークラインのデータ(有限の数値を2点以上)',
        items: { type: 'number' },
      },
      width: { type: 'integer', description: 'SVG全体の幅px(既定 240、最小20・最大4096)' },
      height: { type: 'integer', description: 'SVG全体の高さpx(既定 60、最小20・最大4096)' },
      color: { type: 'string', description: '線と円マーカーの色(例 "#4e79a7" / "tomato"。既定 "#4e79a7")' },
      strokeWidth: { type: 'number', description: '線の太さpx(既定 2、0.1〜50)' },
    },
    required: ['data'],
    additionalProperties: false,
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { data, width, height, color, strokeWidth } = (input ?? {}) as {
      data?: unknown;
      width?: unknown;
      height?: unknown;
      color?: unknown;
      strokeWidth?: unknown;
    };

    const checkSize = (v: unknown, name: string, def: number): number | string => {
      if (v === undefined) return def;
      if (typeof v !== 'number' || !Number.isFinite(v)) return `${name} は数値で指定すること`;
      const n = Math.floor(v);
      if (n < 20 || n > 4096) return `${name} は 20〜4096 の範囲で指定すること(指定値: ${v})`;
      return n;
    };
    const w = checkSize(width, 'width', 240);
    if (typeof w === 'string') return { content: w, isError: true };
    const h = checkSize(height, 'height', 60);
    if (typeof h === 'string') return { content: h, isError: true };

    if (color !== undefined && typeof color !== 'string') {
      return { content: 'color は文字列で指定すること', isError: true };
    }
    // 属性値に " や < を含む色指定はSVG構造を壊すため拒否する
    const lineColor = color ?? '#4e79a7';
    if (/[<>"']/.test(lineColor)) {
      return { content: 'color に <>"\' は使えない', isError: true };
    }

    let sw = 2;
    if (strokeWidth !== undefined) {
      if (typeof strokeWidth !== 'number' || !Number.isFinite(strokeWidth)) {
        return { content: 'strokeWidth は数値で指定すること', isError: true };
      }
      if (strokeWidth < 0.1 || strokeWidth > 50) {
        return { content: `strokeWidth は 0.1〜50 の範囲で指定すること(指定値: ${strokeWidth})`, isError: true };
      }
      sw = strokeWidth;
    }

    const values = parseData(data);
    if (typeof values === 'string') return { content: values, isError: true };

    // レイアウト: マーカー半径ぶんの余白を確保して線・円が見切れないようにする
    const markerR = Math.max(2, sw * 1.5);
    const pad = markerR + Math.max(1, sw / 2);
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;
    if (plotW <= 0 || plotH <= 0) {
      return { content: 'width/height が小さすぎて描画領域を確保できない(strokeWidth を下げるかサイズを上げること)', isError: true };
    }

    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const n = values.length;

    const xAt = (i: number): number => pad + (plotW * i) / (n - 1);
    const yAt = (v: number): number =>
      range > 0 ? pad + plotH * (1 - (v - min) / range) : pad + plotH / 2;

    const points: string[] = [];
    let minIndex = 0;
    let maxIndex = 0;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === undefined) continue; // noUncheckedIndexedAccess ガード(範囲内なので実際は通らない)
      points.push(`${fmt(xAt(i))},${fmt(yAt(v))}`);
      const vMin = values[minIndex];
      const vMax = values[maxIndex];
      if (vMin !== undefined && v < vMin) minIndex = i;
      if (vMax !== undefined && v > vMax) maxIndex = i;
    }

    const minV = values[minIndex];
    const maxV = values[maxIndex];
    if (minV === undefined || maxV === undefined) {
      return { content: '内部エラー: 最小・最大点を特定できなかった', isError: true };
    }

    const parts: string[] = [];
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    );
    parts.push(
      `<polyline points="${points.join(' ')}" fill="none" stroke="${lineColor}" stroke-width="${fmt(sw)}" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    // 最大点マーカー(線色の塗り)と最小点マーカー(白抜き+線色の縁)
    parts.push(
      `<circle cx="${fmt(xAt(maxIndex))}" cy="${fmt(yAt(maxV))}" r="${fmt(markerR)}" fill="${lineColor}"/>`,
    );
    parts.push(
      `<circle cx="${fmt(xAt(minIndex))}" cy="${fmt(yAt(minV))}" r="${fmt(markerR)}" fill="#ffffff" stroke="${lineColor}" stroke-width="1"/>`,
    );
    parts.push('</svg>');

    return { content: JSON.stringify({ svg: parts.join('') }) };
  },
} satisfies ToolPlugin;
