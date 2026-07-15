import { describe, expect, it } from 'vitest';
import calendarHeatmapSvg from './calendar_heatmap_svg';
import type { ToolContext } from '../types';

function ctx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {} };
}

function parseSvg(content: string): string {
  const parsed = JSON.parse(content) as { svg?: unknown };
  expect(typeof parsed.svg).toBe('string');
  return parsed.svg as string;
}

type DayRect = {
  date: string;
  level: number;
  x: number;
  y: number;
  width: number;
  fill: string;
  opacity: number | undefined;
};

/** class="day" の rect を属性つきで抽出する */
function extractDayRects(svg: string): DayRect[] {
  const re =
    /<rect class="day" data-date="([^"]+)" data-level="(\d)" x="([\d.-]+)" y="([\d.-]+)" width="(\d+)" height="\d+" rx="\d+" fill="([^"]+)"(?: fill-opacity="([\d.]+)")?>/g;
  return [...svg.matchAll(re)].map((m) => ({
    date: m[1] ?? '',
    level: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
    width: Number(m[5]),
    fill: m[6] ?? '',
    opacity: m[7] === undefined ? undefined : Number(m[7]),
  }));
}

function extractLegendLevels(svg: string): number[] {
  return [...svg.matchAll(/<rect class="legend" data-level="(\d)"/g)].map((m) => Number(m[1]));
}

// 2026-01-04 は日曜日
const weekData = [
  { date: '2026-01-04', value: 0 },
  { date: '2026-01-05', value: 1 },
  { date: '2026-01-06', value: 4 },
  { date: '2026-01-07', value: 8 },
  { date: '2026-01-10', value: 2 },
];

describe('calendar_heatmap_svg', () => {
  it('rect グリッドと凡例を含む <svg> 文字列を {svg} として返す', async () => {
    const r = await calendarHeatmapSvg.execute({ data: weekData }, ctx());
    expect(r.isError).toBeUndefined();
    const svg = parseSvg(r.content);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('<rect class="day"');
    expect(svg).toContain('Less');
    expect(svg).toContain('More');
  });

  it('日付範囲の全日ぶんのマスが描かれる(データが無い日は段階0)', async () => {
    const r = await calendarHeatmapSvg.execute({ data: weekData }, ctx());
    const rects = extractDayRects(parseSvg(r.content));
    // 2026-01-04〜2026-01-10 の7日ぶん
    expect(rects).toHaveLength(7);
    const jan8 = rects.find((d) => d.date === '2026-01-08');
    expect(jan8).toBeDefined();
    expect(jan8?.level).toBe(0);
    expect(jan8?.fill).toBe('#ebedf0');
  });

  it('値の大きさで5段階に量子化される(最大値=4、0=空)', async () => {
    const r = await calendarHeatmapSvg.execute({ data: weekData }, ctx());
    const rects = extractDayRects(parseSvg(r.content));
    const byDate = new Map(rects.map((d) => [d.date, d]));
    expect(byDate.get('2026-01-04')?.level).toBe(0); // 値0 → 空
    expect(byDate.get('2026-01-05')?.level).toBe(1); // 1/8 → ceil(0.5)=1
    expect(byDate.get('2026-01-06')?.level).toBe(2); // 4/8 → 2
    expect(byDate.get('2026-01-07')?.level).toBe(4); // 最大値 → 4
    expect(byDate.get('2026-01-10')?.level).toBe(1); // 2/8 → 1
    // 段階が上がるほど fill-opacity が濃くなる
    const o1 = byDate.get('2026-01-05')?.opacity;
    const o2 = byDate.get('2026-01-06')?.opacity;
    const o4 = byDate.get('2026-01-07')?.opacity;
    if (o1 === undefined || o2 === undefined || o4 === undefined) {
      throw new Error('fill-opacity が抽出できなかった');
    }
    expect(o1).toBeLessThan(o2);
    expect(o2).toBeLessThan(o4);
    expect(o4).toBe(1);
  });

  it('週が列・曜日が行になる(同じ週は同じx、日曜始まりで曜日ぶんyが下がる)', async () => {
    const r = await calendarHeatmapSvg.execute({ data: weekData }, ctx());
    const rects = extractDayRects(parseSvg(r.content));
    const byDate = new Map(rects.map((d) => [d.date, d]));
    const sun = byDate.get('2026-01-04'); // 日曜(行0)
    const mon = byDate.get('2026-01-05'); // 月曜(行1)
    const sat = byDate.get('2026-01-10'); // 土曜(行6)
    if (!sun || !mon || !sat) throw new Error('マスが抽出できなかった');
    // 同じ週なのでxが等しい
    expect(mon.x).toBe(sun.x);
    expect(sat.x).toBe(sun.x);
    // 曜日ぶんyが増える
    expect(mon.y).toBeGreaterThan(sun.y);
    expect(sat.y).toBeGreaterThan(mon.y);
    expect(sat.y - sun.y).toBeCloseTo((mon.y - sun.y) * 6, 5);
  });

  it('週をまたぐと列(x)が進む', async () => {
    const r = await calendarHeatmapSvg.execute(
      {
        data: [
          { date: '2026-01-04', value: 1 },
          { date: '2026-01-11', value: 2 }, // 翌週の日曜
        ],
      },
      ctx(),
    );
    const rects = extractDayRects(parseSvg(r.content));
    const byDate = new Map(rects.map((d) => [d.date, d]));
    const w1 = byDate.get('2026-01-04');
    const w2 = byDate.get('2026-01-11');
    if (!w1 || !w2) throw new Error('マスが抽出できなかった');
    expect(w2.x).toBeGreaterThan(w1.x);
    expect(w2.y).toBe(w1.y); // どちらも日曜(行0)
  });

  it('凡例が5段階(0〜4)で描かれる', async () => {
    const r = await calendarHeatmapSvg.execute({ data: weekData }, ctx());
    expect(extractLegendLevels(parseSvg(r.content))).toEqual([0, 1, 2, 3, 4]);
  });

  it('color / cell の指定が反映される', async () => {
    const r = await calendarHeatmapSvg.execute(
      { data: weekData, color: 'tomato', cell: 20 },
      ctx(),
    );
    const svg = parseSvg(r.content);
    expect(svg).toContain('fill="tomato"');
    const rects = extractDayRects(svg);
    expect(rects.length).toBeGreaterThan(0);
    for (const d of rects) {
      expect(d.width).toBe(20);
      if (d.level > 0) expect(d.fill).toBe('tomato');
    }
  });

  it('重複した日付の値は合算される', async () => {
    const r = await calendarHeatmapSvg.execute(
      {
        data: [
          { date: '2026-01-05', value: 3 },
          { date: '2026-01-05', value: 5 },
          { date: '2026-01-06', value: 8 },
        ],
      },
      ctx(),
    );
    const rects = extractDayRects(parseSvg(r.content));
    const byDate = new Map(rects.map((d) => [d.date, d]));
    // 3+5=8 で最大値と同じ → どちらも段階4
    expect(byDate.get('2026-01-05')?.level).toBe(4);
    expect(byDate.get('2026-01-06')?.level).toBe(4);
    // title に合算値が入る
    expect(parseSvg(r.content)).toContain('<title>2026-01-05: 8</title>');
  });

  it('月ラベルと曜日ラベルが付く', async () => {
    const r = await calendarHeatmapSvg.execute(
      {
        data: [
          { date: '2026-01-28', value: 1 },
          { date: '2026-02-03', value: 2 },
        ],
      },
      ctx(),
    );
    const svg = parseSvg(r.content);
    expect(svg).toContain('>Jan</text>');
    expect(svg).toContain('>Feb</text>');
    expect(svg).toContain('>Mon</text>');
    expect(svg).toContain('>Wed</text>');
    expect(svg).toContain('>Fri</text>');
  });

  it('不正入力はエラーを返す', async () => {
    const cases: Array<Record<string, unknown>> = [
      {}, // data なし
      { data: 'x' }, // 配列でない
      { data: [] }, // 空
      { data: [{ date: '2026/01/05', value: 1 }] }, // 書式不正
      { data: [{ date: '2026-02-30', value: 1 }] }, // 実在しない日付
      { data: [{ date: '2026-01-05', value: -1 }] }, // 負の値
      { data: [{ date: '2026-01-05', value: Number.NaN }] }, // NaN
      { data: [{ date: '2026-01-05' }] }, // value なし
      { data: [null] }, // 要素がオブジェクトでない
      { data: weekData, color: 'red"onload="x' }, // 危険な色文字列
      { data: weekData, cell: 3 }, // cell 範囲外(小)
      { data: weekData, cell: 100 }, // cell 範囲外(大)
    ];
    for (const input of cases) {
      const r = await calendarHeatmapSvg.execute(input, ctx());
      expect(r.isError, JSON.stringify(input)).toBe(true);
    }
  });

  it('日付範囲が3700日を超えるとエラー', async () => {
    const r = await calendarHeatmapSvg.execute(
      {
        data: [
          { date: '2000-01-01', value: 1 },
          { date: '2020-01-01', value: 2 },
        ],
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('期間が長すぎる');
  });

  it('全ての値が0でも空マスとして描ける', async () => {
    const r = await calendarHeatmapSvg.execute(
      { data: [{ date: '2026-01-05', value: 0 }] },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    const rects = extractDayRects(parseSvg(r.content));
    expect(rects).toHaveLength(1);
    expect(rects[0]?.level).toBe(0);
  });
});
