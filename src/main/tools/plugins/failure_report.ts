import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * M111: 進化ジョブ失敗の調査レポート(読み取り専用)。
 * jobs.json から status=failed のジョブを拾い、失敗フェーズとエラー文言を要約して JSON で返す。
 * 「進化ジョブがどのフェーズで・なぜ失敗したかをまとめて把握したい」という再調査の入口。
 * ファイルを読むだけで、書き込み・外部アクセスは行わない。
 */

export interface FailureReport {
  id: number | null;
  phase: string;
  error: string;
}

interface FailureReportInput {
  limit?: number;
  path?: string;
}

function isInput(value: unknown): value is FailureReportInput {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { [key: string]: unknown };
  if ('limit' in v && v.limit !== undefined) {
    if (typeof v.limit !== 'number' || !Number.isInteger(v.limit) || v.limit < 1) return false;
  }
  if ('path' in v && v.path !== undefined && typeof v.path !== 'string') return false;
  return true;
}

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 100;
const ERROR_MAX_LEN = 200;

/** エラー文言を1行に畳み、長すぎる場合は末尾を切り詰める */
export function summarizeError(raw: string, max: number = ERROR_MAX_LEN): string {
  const line = raw.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

/** jobs.json の本文からジョブ配列を取り出す(配列直下 / {jobs:[...]} の両対応) */
export function parseJobsJson(text: string): unknown[] {
  const data: unknown = JSON.parse(text);
  if (Array.isArray(data)) return data;
  if (data !== null && typeof data === 'object') {
    const jobs = (data as { jobs?: unknown }).jobs;
    if (Array.isArray(jobs)) return jobs;
  }
  throw new Error('jobs.json の形式が不正です(配列または {jobs: [...]} を期待)');
}

function toReport(job: unknown): FailureReport | null {
  if (job === null || typeof job !== 'object') return null;
  const j = job as { [key: string]: unknown };
  if (j.status !== 'failed') return null;
  const id = typeof j.id === 'number' && Number.isFinite(j.id) ? j.id : null;
  const phaseRaw =
    typeof j.phase === 'string' ? j.phase : typeof j.failedPhase === 'string' ? j.failedPhase : '';
  const phase = phaseRaw.trim() !== '' ? phaseRaw.trim() : 'unknown';
  const errorRaw =
    typeof j.error === 'string' ? j.error : typeof j.message === 'string' ? j.message : '';
  return { id, phase, error: summarizeError(errorRaw) };
}

/** status=failed のジョブを新しい順(id降順・ID無しは末尾)に limit 件まで要約する */
export function buildFailureReports(jobs: unknown[], limit: number): FailureReport[] {
  const failed = jobs.map(toReport).filter((r): r is FailureReport => r !== null);
  failed.sort((a, b) => (b.id ?? -Infinity) - (a.id ?? -Infinity));
  return failed.slice(0, limit);
}

const plugin = {
  name: 'failure_report',
  description:
    '進化ジョブの永続ログ(jobs.json)から status=failed の失敗ジョブを拾い、失敗フェーズとエラー文言を要約して {"reports":[{"id","phase","error"}]} 形式の JSON で返す読み取り専用ツール。進化ジョブ失敗の調査(どのフェーズで・なぜ落ちたか)の入口に使う。limit(既定5・最大100)で新しい順に最大件数を指定できる。path で jobs.json の場所を指定できる(省略時はカレントディレクトリの jobs.json)。',
  risk: 'safe',
  tags: ['ファイル操作', '進化'],
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description: '返す失敗ジョブの最大件数(既定5・最大100)。新しい順。',
      },
      path: {
        type: 'string',
        description: 'jobs.json のパス。省略時はカレントディレクトリの jobs.json。',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isInput(input)) {
      return {
        content:
          'Invalid input: 任意で "limit"(1以上の整数) と "path"(文字列) を持つオブジェクトを渡してください。',
        isError: true,
      };
    }
    const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const filePath = resolve(ctx.cwd, input.path ?? 'jobs.json');

    let text: string;
    try {
      text = await readFile(filePath, 'utf8');
    } catch {
      return {
        content: `jobs.json を読めませんでした: ${filePath}(ファイルが無いか、アクセスできません)`,
        isError: true,
      };
    }

    let jobs: unknown[];
    try {
      jobs = parseJobsJson(text);
    } catch (e) {
      return {
        content: `jobs.json の解析に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }

    const reports = buildFailureReports(jobs, limit);
    return { content: JSON.stringify({ reports }, null, 2) };
  },
} satisfies ToolPlugin;

export default plugin;
