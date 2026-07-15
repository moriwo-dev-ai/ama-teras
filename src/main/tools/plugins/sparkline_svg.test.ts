import { describe, expect, it } from 'vitest';
import sparklineSvg from './sparkline_svg';
import type { ToolContext } from '../types';

function ctx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} };
}

function parseSvg(content: string): string {
  const parsed = JSON.parse(content) as { svg?: unknown };
  expect(typeof parsed.svg).toBe('string');
  return parsed.svg as string;
}

/** polyline の points 属性を [x, y] の配列にして返す */
function extractPoints(svg: string): Array<[number, number]> {
  const m = svg.match(/<polyline points="([^"]*)"/);
  if (!m || m[1] === undefined) throw new Error('polyline が見つからない');
  return m[1].split(' ').map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    if (x === undefined || y === undefined || Number.isNaN(x) || Number.isNaN(y)) {
      throw new Error(`不正な座標: ${pair}`);
    }
    return [x, y];
  });
}

function extractCircles(svg: string): Array<{ cx: number; cy: number }> {
  return [...svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)"/g)].map((m) => ({
    cx: Number(m[1]),
    cy: Number(m[2]),
  }));
}

const basicData = [3, 7, 1, 9, 4];

describe('sparkline_svg', () => {
  it('polyline と circle を含む <svg> 文字列を {svg} として返す', async () => {
    const r = await sparklineSvg.execute({ data: basicData }, ctx());
    expect(r.isError).toBeUndefined();
    const svg = parseSvg(r.content);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('<polyline');
    expect(svg).toContain('<circle');
  });

  it('データ点数ぶんの座標が polyline に含まれ、円マーカーは2個', async () => {
    const r = await sparklineSvg.execute({ data: basicData }, ctx());
    const svg = parseSvg(r.content);
    expect(extractPoints(svg)).toHaveLength(basicData.length);
    expect(extractCircles(svg)).toHaveLength(2);
  });

  it('値が幅・高さに正規化される(最大値がy最小、最小値がy最大、xは等間隔)', async () => {
    const r = await sparklineSvg.execute({ data: [0, 10, 5], width: 200, height: 100 }, ctx());
    const svg = parseSvg(r.content);
    const pts = extractPoints(svg);
    const p0 = pts[0];
    const p1 = pts[1];
    const p2 = pts[2];
    if (!p0 || !p1 || !p2) throw new Error('3点抽出できなかった');
    // 最大値(10)のyが最小、最小値(0)のyが最大
    expect(p1[1]).toBeLessThan(p0[1]);
    expect(p1[1]).toBeLessThan(p2[1]);
    expect(p0[1]).toBeGreaterThan(p2[1]);
    // xは等間隔で単調増加
    expect(p1[0] - p0[0]).toBeCloseTo(p2[0] - p1[0], 1);
    // 全座標がキャンバス内
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(200);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('最小点・最大点の座標に円マーカーが付く', async () => {
    const r = await sparklineSvg.execute({ data: [3, 7, 1, 9, 4] }, ctx());
    const svg = parseSvg(r.content);
    const pts = extractPoints(svg);
    const circles = extractCircles(svg);
    const maxPt = pts[3]; // 値9(最大)
    const minPt = pts[2]; // 値1(最小)
    if (!maxPt || !minPt) throw new Error('点が抽出できなかった');
    const c0 = circles[0];
    const c1 = circles[1];
    if (!c0 || !c1) throw new Error('円が2個抽出できなかった');
    // 1個目=最大点マーカー、2個目=最小点マーカー
    expect(c0.cx).toBeCloseTo(maxPt[0], 1);
    expect(c0.cy).toBeCloseTo(maxPt[1], 1);
    expect(c1.cx).toBeCloseTo(minPt[0], 1);
    expect(c1.cy).toBeCloseTo(minPt[1], 1);
  });

  it('width/height/color/strokeWidth の指定が反映される', async () => {
    const r = await sparklineSvg.execute(
      { data: basicData, width: 300, height: 80, color: 'tomato', strokeWidth: 3 },
      ctx(),
    );
    const svg = parseSvg(r.content);
    expect(svg).toContain('width="300"');
    expect(svg).toContain('height="80"');
    expect(svg).toContain('stroke="tomato"');
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('fill="tomato"');
  });

  it('既定値: width 240 / height 60 / 色 #4e79a7 / 太さ 2', async () => {
    const r = await sparklineSvg.execute({ data: basicData }, ctx());
    const svg = parseSvg(r.content);
    expect(svg).toContain('width="240"');
    expect(svg).toContain('height="60"');
    expect(svg).toContain('stroke="#4e79a7"');
    expect(svg).toContain('stroke-width="2"');
  });

  it('全値が同じでもエラーにならず水平線を中央に描く', async () => {
    const r = await sparklineSvg.execute({ data: [5, 5, 5], height: 100 }, ctx());
    expect(r.isError).toBeUndefined();
    const svg = parseSvg(r.content);
    const pts = extractPoints(svg);
    const ys = pts.map(([, y]) => y);
    const y0 = ys[0];
    if (y0 === undefined) throw new Error('点が抽出できなかった');
    for (const y of ys) expect(y).toBeCloseTo(y0, 5);
    expect(y0).toBeCloseTo(50, 0);
  });

  it('負の値を含むデータも正規化して描ける', async () => {
    const r = await sparklineSvg.execute({ data: [-10, 0, 10] }, ctx());
    expect(r.isError).toBeUndefined();
    const svg = parseSvg(r.content);
    expect(extractPoints(svg)).toHaveLength(3);
    expect(extractCircles(svg)).toHaveLength(2);
  });

  describe('入力バリデーション', () => {
    it('data が無い/空/1点/非配列/非数値/非有限はエラー', async () => {
      const cases = [
        {},
        { data: [] },
        { data: [1] },
        { data: 'x' },
        { data: [1, 'a'] },
        { data: [1, NaN] },
        { data: [1, Infinity] },
      ];
      for (const bad of cases) {
        const r = await sparklineSvg.execute(bad, ctx());
        expect(r.isError).toBe(true);
      }
    });

    it('width/height の範囲外・非数値はエラー', async () => {
      for (const bad of [
        { data: basicData, width: 10 },
        { data: basicData, width: 5000 },
        { data: basicData, height: 'x' },
      ]) {
        const r = await sparklineSvg.execute(bad, ctx());
        expect(r.isError).toBe(true);
      }
    });

    it('strokeWidth の範囲外・非数値はエラー', async () => {
      for (const bad of [
        { data: basicData, strokeWidth: 0 },
        { data: basicData, strokeWidth: 100 },
        { data: basicData, strokeWidth: 'x' },
      ]) {
        const r = await sparklineSvg.execute(bad, ctx());
        expect(r.isError).toBe(true);
      }
    });

    it('color に <>"\' を含む指定・非文字列はエラー(SVG構造破壊の防止)', async () => {
      for (const bad of [
        { data: basicData, color: '"><script>' },
        { data: basicData, color: 42 },
      ]) {
        const r = await sparklineSvg.execute(bad, ctx());
        expect(r.isError).toBe(true);
      }
    });
  });
});
