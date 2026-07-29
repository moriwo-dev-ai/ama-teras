import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import failureReport, {
  buildFailureReports,
  parseJobsJson,
  summarizeError,
} from './failure_report';
import type { ToolContext } from '../types';

let dir = '';

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal, log: () => {} };
}

async function writeJobs(jobs: unknown): Promise<string> {
  const p = join(dir, 'jobs.json');
  await writeFile(p, JSON.stringify(jobs), 'utf8');
  return p;
}

const jobsFixture = [
  { id: 55, status: 'done' },
  { id: 56, status: 'failed', log: ['[typecheck]開始', '[typecheck]TS2339: Property x does not exist'], error: 'TS2339: Property x does not exist' },
  { id: 57, status: 'failed', log: ['[generation]モデル応答を解析中', '[generation]JSONとして解析できません'], error: 'モデル応答がJSONとして解析できません' },
  { id: 58, status: 'running' },
];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'failure-report-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('failure_report 純関数', () => {
  it('parseJobsJson: 配列直下と {jobs:[...]} の両方を受け付ける', () => {
    expect(parseJobsJson('[{"id":1}]')).toEqual([{ id: 1 }]);
    expect(parseJobsJson('{"jobs":[{"id":2}]}')).toEqual([{ id: 2 }]);
  });

  it('parseJobsJson: 不正な形式は例外', () => {
    expect(() => parseJobsJson('{"jobs":{}}')).toThrow();
    expect(() => parseJobsJson('not json')).toThrow();
  });

  it('summarizeError: 改行を畳み長文を切り詰める', () => {
    expect(summarizeError('a\nb   c')).toBe('a b c');
    const long = 'x'.repeat(300);
    const out = summarizeError(long);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('…')).toBe(true);
  });

  it('buildFailureReports: failed のみ新しい順・limit 件まで返す', () => {
    const reports = buildFailureReports(jobsFixture, 10);
    expect(reports).toEqual([
      { id: 57, phase: 'generation', error: 'モデル応答がJSONとして解析できません' },
      { id: 56, phase: 'typecheck', error: 'TS2339: Property x does not exist' },
    ]);
    expect(buildFailureReports(jobsFixture, 1)).toHaveLength(1);
  });

  it('buildFailureReports: phase/error 欠落は unknown/空文字、message/errorMessage も拾う', () => {
    const reports = buildFailureReports(
      [
        { id: 1, status: 'failed' },
        { id: 2, status: 'failed', log: ['[smoke]smoke timeout'], message: 'smoke timeout' },
      ],
      10,
    );
    expect(reports[0]).toEqual({ id: 2, phase: 'smoke', error: 'smoke timeout' });
    expect(reports[1]).toEqual({ id: 1, phase: 'unknown', error: '' });
  });
});

describe('failure_report execute(M111: 失敗ジョブ調査レポート)', () => {
  it('jobs.json から failed ジョブを新しい順にJSONで返す', async () => {
    const p = await writeJobs(jobsFixture);
    const r = await failureReport.execute({ path: p }, ctx(dir));
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as { reports: unknown[] };
    expect(parsed.reports).toEqual([
      { id: 57, phase: 'generation', error: 'モデル応答がJSONとして解析できません' },
      { id: 56, phase: 'typecheck', error: 'TS2339: Property x does not exist' },
    ]);
  });

  it('limit で件数を絞れる', async () => {
    const p = await writeJobs(jobsFixture);
    const r = await failureReport.execute({ path: p, limit: 1 }, ctx(dir));
    const parsed = JSON.parse(r.content) as { reports: { id: number }[] };
    expect(parsed.reports).toHaveLength(1);
    expect(parsed.reports[0]?.id).toBe(57);
  });

  it('path 省略時は cwd の jobs.json を読む', async () => {
    await writeJobs([{ id: 9, status: 'failed', phase: 'test', error: 'boom' }]);
    const r = await failureReport.execute({}, ctx(dir));
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('"id": 9');
  });

  it('failed が無ければ空の reports を返す(エラーではない)', async () => {
    const p = await writeJobs([{ id: 1, status: 'done' }]);
    const r = await failureReport.execute({ path: p }, ctx(dir));
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content)).toEqual({ reports: [] });
  });

  it('ファイルが無ければエラー', async () => {
    const r = await failureReport.execute({ path: join(dir, 'nope.json') }, ctx(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('読めませんでした');
  });

  it('JSONが壊れていればエラー', async () => {
    const p = join(dir, 'jobs.json');
    await writeFile(p, '{broken', 'utf8');
    const r = await failureReport.execute({ path: p }, ctx(dir));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('解析に失敗');
  });

  it('不正な入力(0以下のlimit等)はエラー', async () => {
    const r = await failureReport.execute({ limit: 0 }, ctx(dir));
    expect(r.isError).toBe(true);
    const r2 = await failureReport.execute({ limit: 'x' }, ctx(dir));
    expect(r2.isError).toBe(true);
  });
});
