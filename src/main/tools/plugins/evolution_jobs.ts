import type { ToolContext, ToolPlugin, ToolResult } from '../types';
import type { EvolutionJobSummary } from '../../../shared/types';

/**
 * M24: 進化パイプラインの内部ログをモデルが自分で確認できるようにする読み取り専用ツール。
 * 「進化が失敗した理由(どのゲートで落ちたか・ログ)」をチャットから調べられないという要望への対応。
 * 状態は現行プロセスのメモリ上にしかないため、再起動で揮発する(過去の昇格済み能力は別途 EvolutionPanel を参照)。
 */

interface EvolutionJobsInput {
  id?: number;
  logTail?: number;
}

function isInput(value: unknown): value is EvolutionJobsInput {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { [key: string]: unknown };
  if ('id' in v && v.id !== undefined && typeof v.id !== 'number') return false;
  if ('logTail' in v && v.logTail !== undefined && typeof v.logTail !== 'number') return false;
  return true;
}

/** 説明を1行に畳んで一覧表向けに短く切る */
function shortDesc(desc: string, max = 48): string {
  const line = desc.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function failedGates(job: EvolutionJobSummary): string {
  const bad = job.gates.filter((g) => !g.ok).map((g) => g.name);
  return bad.length > 0 ? bad.join(',') : '-';
}

function renderSummaryTable(jobs: EvolutionJobSummary[]): string {
  const header = 'id | status | scope | tool | 失敗ゲート | 説明';
  const rows = jobs
    .slice()
    .sort((a, b) => a.id - b.id)
    .map(
      (j) =>
        `${j.id} | ${j.status} | ${j.scope ?? 'tool'} | ${j.toolName ?? '-'} | ${failedGates(j)} | ${shortDesc(j.description)}`,
    );
  return [header, ...rows].join('\n');
}

function renderDetail(job: EvolutionJobSummary, logTail: number): string {
  const lines: string[] = [];
  lines.push(`進化ジョブ #${job.id}`);
  lines.push(`status: ${job.status}${job.protectedReject ? '(保護領域による拒否)' : ''}`);
  lines.push(`scope: ${job.scope ?? 'tool'}${job.requiresRestart ? '(再起動を要する)' : ''}`);
  if (job.toolName) lines.push(`tool: ${job.toolName}`);
  lines.push(`説明: ${job.description.replace(/\s+/g, ' ').trim()}`);
  if (job.error) lines.push(`error: ${job.error}`);

  lines.push('');
  lines.push('ゲート結果:');
  if (job.gates.length === 0) {
    lines.push('  (まだ検証に到達していない)');
  } else {
    for (const g of job.gates) {
      lines.push(`  [${g.ok ? '合格' : '不合格'}] ${g.name}: ${g.detail}`);
    }
  }

  lines.push('');
  const tail = logTail > 0 ? job.log.slice(-logTail) : job.log;
  const omitted = job.log.length - tail.length;
  lines.push(`ログ(全${job.log.length}行${omitted > 0 ? `・末尾${tail.length}行を表示` : ''}):`);
  if (tail.length === 0) {
    lines.push('  (ログなし)');
  } else {
    for (const l of tail) lines.push(`  ${l}`);
  }
  return lines.join('\n');
}

const plugin: ToolPlugin = {
  name: 'evolution_jobs',
  description:
    '進化パイプライン(自己進化)の内部状態を確認する読み取り専用ツール。id を省略すると現行プロセスで走った全ジョブの一覧(状態・スコープ・失敗ゲート)を返す。id を指定するとそのジョブのゲート詳細とログ末尾を返す。進化(request_capability)が失敗した理由を自分で調べたいときに使う。状態はアプリ再起動で揮発する。',
  risk: 'safe',
  tags: ['進化'],
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: '詳細を見たい進化ジョブのID。省略すると一覧を返す。' },
      logTail: {
        type: 'integer',
        description: '詳細表示時に返すログの末尾行数(既定40、0で全行)。',
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isInput(input)) {
      return {
        content: 'Invalid input: 任意の数値フィールド "id" / "logTail" を持つオブジェクトを渡してください。',
        isError: true,
      };
    }
    const list = ctx.evolution?.list;
    if (!list) {
      return {
        content: '進化パイプラインにアクセスできません(このコンテキストでは evolution.list が未注入です)。',
        isError: true,
      };
    }

    const jobs = list();
    if (input.id !== undefined) {
      const job = jobs.find((j) => j.id === input.id);
      if (!job) {
        const known = jobs.map((j) => j.id).sort((a, b) => a - b);
        return {
          content:
            `進化ジョブ #${input.id} は現行プロセスに見つかりません(再起動で揮発した可能性)。` +
            (known.length > 0 ? `既知のID: ${known.join(', ')}` : '現在ジョブはありません。'),
          isError: true,
        };
      }
      const logTail = input.logTail ?? 40;
      return { content: renderDetail(job, logTail) };
    }

    if (jobs.length === 0) {
      // M91: 配布版でもツール生成ジョブは走る(プラグイン単位の検証ゲート)。
      // ただしレジストリ/ファイルからの**導入**はジョブを起票せずその場で完結するため、
      // 「導入したのにジョブが無い」ことをエージェントが異常と誤診しないよう明示する
      if (ctx.packaged === true) {
        return {
          content:
            '進化ジョブはまだありません。配布版では、request_capability による**ツールの生成**はジョブとして走ります' +
            '(型検査→テスト実行→スモークの検証ゲートを通り、全文承認のうえ導入)。' +
            '一方、レジストリや手元のファイルからの**既存プラグインの導入**は、検査→承認→配置でその場で完結し、' +
            'ジョブとしては残りません(導入済みのツールは tools 一覧に出ます)。' +
            'なお本体(core/renderer)の書き換えは配布版では行えません。',
        };
      }
      return {
        content:
          '現行プロセスで走った進化ジョブはありません(再起動後は空になります)。過去に昇格した能力は EvolutionPanel の「獲得した能力」で確認できます。',
      };
    }
    return { content: renderSummaryTable(jobs) };
  },
};

export default plugin;
