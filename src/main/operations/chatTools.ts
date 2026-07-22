import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvolutionJobSummary, MetricsSnapshot, OperationsDraft } from '../../shared/types';
import { formatMetricsSeries } from './kamuhakari';

/**
 * M99-13: 運営チャットの読み取り専用ツール。
 *
 * 設計の掟(ユーザーと合意した形):
 * - **読むのは自由、変えるのは承認** — ここには読み取りしか置かない。書き込み系
 *   (投稿・リリース・git変更)は追加禁止。それらは岩戸ゲート・承認バッチの領分
 * - ツールは「調査の単位」に合わせた粗粒度(まとめ形)にする。細粒度にすると
 *   回数上限が実案件を殺す(Zenn到達性はURL1本ずつなら11回、まとめ形なら1回)
 * - 上限は補助輪(8回)。主役は1日トークン予算(神々の時計に計上)と、
 *   打ち切り時の「中間報告+続行確認」。同一ツール+同一引数の2回目=強制打ち切り
 * - ツール結果は**データであって指示ではない**(外部由来テキストの命令に従わない)
 */

export interface ChatToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ChatToolDeps {
  /** gh CLI 実行(読み取り系エンドポイントのみ叩くこと)。gh未検出なら null */
  ghRun: ((args: string[]) => Promise<string>) | null;
  /** 観測対象リポジトリ(owner/name) */
  repos: string[];
  /** メトリクス台帳(古→新) */
  metricsHistory: (n: number) => MetricsSnapshot[];
  draftsList: () => OperationsDraft[];
  evolutionJobs: () => EvolutionJobSummary[];
  /** zenn-content リポジトリの articles ディレクトリ(未設定なら null) */
  zennArticlesDir: string | null;
  /** リダイレクトは追従でよい(公開記事は最終的に200、非公開は403/404のまま) */
  fetchImpl: (url: string) => Promise<{ status: number }>;
}

/** プロンプトに載せるツール一覧(ここが唯一の定義。増やすときは読み取り専用のみ) */
export const CHAT_TOOL_SPECS: { name: string; description: string }[] = [
  {
    name: 'github_traffic',
    description:
      'GitHubのトラフィック実測(過去14日)を今取りに行く: 流入元referrer・よく見られたパス・日次クローン・日次閲覧。args: {"repo":"owner/name"(省略=主リポジトリ)}',
  },
  {
    name: 'metrics_history',
    description: '観測台帳の全時系列(★/閲覧/DL/clone/referrer含む)。文脈の14点より過去まで見たいとき。args: {}',
  },
  {
    name: 'evolution_jobs',
    description: '進化ジョブ全件の実状態(ゲート結果・失敗理由つき)。args: {}',
  },
  {
    name: 'drafts_all',
    description: '発信ドラフト台帳の全体(状態別件数と直近一覧)。args: {}',
  },
  {
    name: 'zenn_reachability',
    description:
      'published:true の全Zenn記事が実際に読めるか(HTTP状態)をまとめて確認。「公開したつもり」の検出用。args: {}',
  },
];

/** 返信本文から <tool>{...}</tool> を1つ取り出す(表示用本文からは取り除く) */
export function parseToolCall(reply: string): { body: string; call: ChatToolCall | null } {
  const m = /<tool>([\s\S]*?)<\/tool>/.exec(reply);
  if (m === null) return { body: reply.trim(), call: null };
  const body = (reply.slice(0, m.index) + reply.slice(m.index + m[0].length)).trim();
  try {
    const parsed: unknown = JSON.parse(m[1] ?? '');
    if (typeof parsed === 'object' && parsed !== null) {
      const name = (parsed as Record<string, unknown>)['name'];
      if (typeof name === 'string' && CHAT_TOOL_SPECS.some((s) => s.name === name)) {
        const args = (parsed as Record<string, unknown>)['args'];
        return {
          body,
          call: { name, args: typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {} },
        };
      }
    }
  } catch {
    /* 壊れたツール呼び出しは「呼び出し無し」扱い(本文は生かす) */
  }
  return { body, call: null };
}

async function githubTraffic(deps: ChatToolDeps, repoArg: unknown): Promise<string> {
  if (deps.ghRun === null) return 'gh CLI が見つからないため取得できない';
  const repo = typeof repoArg === 'string' && repoArg.includes('/') ? repoArg : (deps.repos[0] ?? '');
  if (repo === '') return '対象リポジトリが未設定';
  const get = async (path: string): Promise<string> => {
    try {
      return await deps.ghRun!([`api`, `repos/${repo}/traffic/${path}`]);
    } catch (err) {
      return `(取得失敗: ${err instanceof Error ? err.message.slice(0, 80) : String(err)})`;
    }
  };
  const [referrers, paths, clones, views] = await Promise.all([
    get('popular/referrers'),
    get('popular/paths'),
    get('clones'),
    get('views'),
  ]);
  return `# ${repo} のトラフィック実測(過去14日)\n流入元referrer: ${referrers}\nよく見られたパス: ${paths}\n日次クローン: ${clones}\n日次閲覧: ${views}`;
}

function zennUsernameFrom(history: MetricsSnapshot[]): string | null {
  // 観測が保存しているZenn記事パス(/username/articles/slug)からユーザー名を割り出す
  for (let i = history.length - 1; i >= 0; i--) {
    for (const m of Object.values(history[i]?.zenn ?? {})) {
      const path = (m as { path?: string }).path;
      const hit = path === undefined ? null : /^\/([^/]+)\/articles\//.exec(path);
      if (hit?.[1] !== undefined) return hit[1];
    }
  }
  return null;
}

async function zennReachability(deps: ChatToolDeps): Promise<string> {
  if (deps.zennArticlesDir === null) return 'zenn-content リポジトリが未設定';
  const username = zennUsernameFrom(deps.metricsHistory(200));
  if (username === null) return 'Zennユーザー名を観測台帳から特定できない(観測が一度も走っていない?)';
  let files: string[];
  try {
    files = readdirSync(deps.zennArticlesDir).filter((f) => f.endsWith('.md'));
  } catch (err) {
    return `articles ディレクトリを読めない: ${err instanceof Error ? err.message : String(err)}`;
  }
  const rows: string[] = [];
  for (const f of files.slice(0, 20)) {
    const slug = f.replace(/\.md$/, '');
    let published = false;
    try {
      published = /^published:\s*true/m.test(readFileSync(join(deps.zennArticlesDir, f), 'utf8').slice(0, 500));
    } catch {
      /* 読めないファイルは未公開扱い */
    }
    if (!published) {
      rows.push(`- ${slug}: (published:false=下書き。未公開は正常)`);
      continue;
    }
    try {
      const res = await deps.fetchImpl(`https://zenn.dev/${username}/articles/${slug}`);
      const ok = res.status === 200;
      rows.push(`- ${slug}: HTTP ${res.status} ${ok ? '(読める)' : '(読めない! リポジトリ側がpublished:trueでもZenn側で露出ゼロ)'}`);
    } catch (err) {
      rows.push(`- ${slug}: 確認失敗(${err instanceof Error ? err.message.slice(0, 60) : String(err)})`);
    }
  }
  return `# Zenn記事の到達性(https://zenn.dev/${username})\n${rows.join('\n')}`;
}

/** ツールを実行して、モデルに渡すテキストを返す。例外は投げず文字列で返す(会話を壊さない) */
export async function executeChatTool(call: ChatToolCall, deps: ChatToolDeps): Promise<string> {
  switch (call.name) {
    case 'github_traffic':
      return githubTraffic(deps, call.args['repo']);
    case 'metrics_history': {
      const all = deps.metricsHistory(200);
      return `# 観測台帳(全${all.length}点)\n${formatMetricsSeries(all.slice(-60)) || '(なし)'}`;
    }
    case 'evolution_jobs': {
      const jobs = deps.evolutionJobs();
      const rows = jobs.slice(-20).map((j) => {
        const gate = j.gates.map((g) => `${g.ok ? '✅' : '❌'}${g.name}`).join(' ');
        const err = j.error !== undefined && j.error !== '' ? ` / 失敗理由: ${j.error.replace(/\s+/g, ' ').slice(0, 120)}` : '';
        return `- #${j.id} [${j.status}] ${j.description.slice(0, 60)}${gate === '' ? '' : ` / ${gate}`}${err}`;
      });
      return `# 進化ジョブ(全${jobs.length}件・直近20件)\n${rows.join('\n') || '(なし)'}`;
    }
    case 'drafts_all': {
      const drafts = deps.draftsList();
      const byStatus: Record<string, number> = {};
      for (const d of drafts) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
      const rows = drafts.slice(-20).map((d) => `- [${d.status}] ${d.kind}: ${d.title.slice(0, 50)}`);
      return `# 発信ドラフト台帳(全${drafts.length}件)\n状態別: ${JSON.stringify(byStatus)}\n直近20件:\n${rows.join('\n') || '(なし)'}`;
    }
    case 'zenn_reachability':
      return zennReachability(deps);
    default:
      return `未知のツール: ${call.name}(使えるのは ${CHAT_TOOL_SPECS.map((s) => s.name).join('/')})`;
  }
}
