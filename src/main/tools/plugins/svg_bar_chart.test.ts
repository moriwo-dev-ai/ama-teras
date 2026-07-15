import { describe, expect, it } from 'vitest';
import svgBarChart from './svg_bar_chart';
import type { ToolContext } from '../types';

function ctx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} };
}

function parseSvg(content: string): string {
  const parsed = JSON.parse(content) as { svg?: unknown };
  expect(typeof parsed.svg).toBe('string');
  return parsed.svg as string;
}

const basicData = [
  { label: 'A', value: 10 },
  { label: 'B', value: 20 },
  { label: 'C', value: 5 },
];

describe('svg_bar_chart', () => {
  it('rect/text/line を含む <svg> 文字列を {svg} として返す', async () => {
    const r = await svgBarChart.execute({ data: basicData }, ctx());
    expect(r.isError).toBeUndefined();
    const svg = parseSvg(r.content);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('<rect');
    expect(svg).toContain('<text');
    expect(svg).toContain('<line');
  });

  it('タイトル・ラベル・値テキストが描画される', async () => {
    const r = await svgBarChart.execute({ title: '売上', data: basicData }, ctx());
    const svg = parseSvg(r.content);
    expect(svg).toContain('>売上</text>');
    expect(svg).toContain('>A</text>');
    expect(svg).toContain('>B</text>');
    expect(svg).toContain('>C</text>');
    expect(svg).toContain('>20</text>');
  });

  it('バーの高さは最大値でスケールされる(最大値のバーが描画領域いっぱい)', async () => {
    const r = await svgBarChart.execute(
      { width: 640, height: 400, data: [{ label: 'max', value: 100 }, { label: 'half', value: 50 }] },
      ctx(),
    );
    const svg = parseSvg(r.content);
    const heights = [...svg.matchAll(/<rect [^>]*height="([\d.]+)" fill="#4e79a7"/g)].map((m) => Number(m[1]));
    expect(heights).toHaveLength(2);
    const maxH = heights[0];
    const halfH = heights[1];
    if (maxH === undefined || halfH === undefined) throw new Error('バーが2本抽出できなかった');
    // 描画領域: height 400 - marginTop 24 - marginBottom 40 = 336
    expect(maxH).toBeCloseTo(336, 0);
    expect(halfH).toBeCloseTo(maxH / 2, 1);
  });

  it('width/height/color の指定が反映される', async () => {
    const r = await svgBarChart.execute(
      { width: 800, height: 300, color: 'tomato', data: basicData },
      ctx(),
    );
    const svg = parseSvg(r.content);
    expect(svg).toContain('width="800"');
    expect(svg).toContain('height="300"');
    expect(svg).toContain('fill="tomato"');
  });

  it('Y軸グリッド線が5本(0〜maxの4分割)描画され目盛り値が付く', async () => {
    const r = await svgBarChart.execute({ data: [{ label: 'x', value: 100 }] }, ctx());
    const svg = parseSvg(r.content);
    const gridLines = svg.match(/stroke="#dddddd"/g) ?? [];
    expect(gridLines).toHaveLength(5);
    expect(svg).toContain('>0</text>');
    expect(svg).toContain('>25</text>');
    expect(svg).toContain('>50</text>');
    expect(svg).toContain('>75</text>');
    expect(svg).toContain('>100</text>');
  });

  it('ラベル・タイトルのXML特殊文字はエスケープされる', async () => {
    const r = await svgBarChart.execute(
      { title: 'A & B <chart>', data: [{ label: '"q"', value: 1 }] },
      ctx(),
    );
    const svg = parseSvg(r.content);
    expect(svg).toContain('A &amp; B &lt;chart&gt;');
    expect(svg).toContain('&quot;q&quot;');
    expect(svg).not.toContain('<chart>');
  });

  it('全値が0でもエラーにならず高さ0のバーを描く', async () => {
    const r = await svgBarChart.execute({ data: [{ label: 'z', value: 0 }] }, ctx());
    expect(r.isError).toBeUndefined();
    const svg = parseSvg(r.content);
    expect(svg).toContain('height="0"');
  });

  describe('入力バリデーション', () => {
    it('data が無い/空配列/非配列はエラー', async () => {
      for (const bad of [{}, { data: [] }, { data: 'x' }]) {
        const r = await svgBarChart.execute(bad, ctx());
        expect(r.isError).toBe(true);
      }
    });

    it('label が文字列でない・value が数値でない・負・非有限はエラー', async () => {
      const cases = [
        [{ label: 1, value: 1 }],
        [{ label: 'a', value: 'x' }],
        [{ label: 'a', value: -5 }],
        [{ label: 'a', value: Number.NaN }],
      ];
      for (const data of cases) {
        const r = await svgBarChart.execute({ data }, ctx());
        expect(r.isError).toBe(true);
      }
    });

    it('width/height の範囲外・title/color の型違いはエラー', async () => {
      const cases = [
        { data: basicData, width: 50 },
        { data: basicData, height: 99999 },
        { data: basicData, title: 123 },
        { data: basicData, color: 42 },
      ];
      for (const input of cases) {
        const r = await svgBarChart.execute(input, ctx());
        expect(r.isError).toBe(true);
      }
    });

    it('color に SVG構造を壊す文字が含まれるとエラー', async () => {
      const r = await svgBarChart.execute({ data: basicData, color: '"><script>' }, ctx());
      expect(r.isError).toBe(true);
    });
  });
});
