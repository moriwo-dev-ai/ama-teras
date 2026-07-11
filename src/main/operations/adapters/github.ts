import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { RepoMetrics } from '../../../shared/types';
import type { AdapterRuntime } from '../protocol';

/**
 * M32-2: githubアダプタ。gh CLI(認証済み)経由で read/search/execute。
 * execute(comment / label / merge)は岩戸ゲート経由でのみ呼ばれる(protocol.ts が封印)。
 */

/** gh 実行関数(テストでモック差し替え)。stdout を返し、失敗は例外 */
export type GhRunner = (args: string[]) => Promise<string>;

const GH_KNOWN_PATHS = [
  'gh', // PATH にある場合
  'C:\\Program Files\\GitHub CLI\\gh.exe',
  'C:\\Program Files (x86)\\GitHub CLI\\gh.exe',
];

let detectedGh: string | null | undefined;

/** gh CLI の場所を検出(メモ化)。見つからなければ null(UIで導入案内を出す) */
export function detectGhPath(): string | null {
  if (detectedGh !== undefined) return detectedGh;
  for (const candidate of GH_KNOWN_PATHS) {
    if (candidate === 'gh') continue; // PATH判定は実行時に任せる(存在チェック不可)
    if (existsSync(candidate)) {
      detectedGh = candidate;
      return detectedGh;
    }
  }
  detectedGh = null;
  return detectedGh;
}

/** テスト用: 検出キャッシュのリセット */
export function resetGhDetection(): void {
  detectedGh = undefined;
}

export function defaultGhRunner(ghPath: string): GhRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(ghPath, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() !== '' ? stderr.trim() : err.message));
        else resolve(stdout);
      });
    });
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface GithubIssueSummary {
  number: number;
  title: string;
  author: string;
  kind: 'issue' | 'pr';
  body: string;
  labels: string[];
}

/** read/search 関数群(岩戸ゲートを通さない=観測のみ) */
export class GithubReader {
  constructor(private readonly run: GhRunner) {}

  /** リポジトリの基本メトリクス+traffic(権限がなければtrafficは欠落) */
  async repoMetrics(repo: string): Promise<RepoMetrics> {
    const base = parseJson(await this.run(['api', `repos/${repo}`]));
    const rec = (base ?? {}) as Record<string, unknown>;
    const prsRaw = await this.run(['api', `repos/${repo}/pulls?state=open&per_page=100`]).catch(() => '[]');
    const prs = parseJson(prsRaw);
    const openPRs = Array.isArray(prs) ? prs.length : 0;
    const metrics: RepoMetrics = {
      stars: asNumber(rec['stargazers_count']),
      forks: asNumber(rec['forks_count']),
      watchers: asNumber(rec['subscribers_count']),
      // open_issues_count はPRを含むので引く
      openIssues: Math.max(0, asNumber(rec['open_issues_count']) - openPRs),
      openPRs,
    };

    // traffic はpush権限が必要。403等は静かにスキップ(メトリクス自体は成立させる)
    const views = parseJson(await this.run(['api', `repos/${repo}/traffic/views`]).catch(() => 'null'));
    if (views !== null && typeof views === 'object') {
      metrics.views = asNumber((views as Record<string, unknown>)['count']);
      metrics.viewsUnique = asNumber((views as Record<string, unknown>)['uniques']);
    }
    const clones = parseJson(await this.run(['api', `repos/${repo}/traffic/clones`]).catch(() => 'null'));
    if (clones !== null && typeof clones === 'object') {
      metrics.clones = asNumber((clones as Record<string, unknown>)['count']);
      metrics.clonesUnique = asNumber((clones as Record<string, unknown>)['uniques']);
    }
    const refs = parseJson(
      await this.run(['api', `repos/${repo}/traffic/popular/referrers`]).catch(() => 'null'),
    );
    if (Array.isArray(refs)) {
      metrics.referrers = refs.map((r) => {
        const rr = r as Record<string, unknown>;
        return {
          referrer: String(rr['referrer'] ?? ''),
          count: asNumber(rr['count']),
          uniques: asNumber(rr['uniques']),
        };
      });
    }
    const releases = parseJson(await this.run(['api', `repos/${repo}/releases`]).catch(() => 'null'));
    if (Array.isArray(releases)) {
      let downloads = 0;
      for (const rel of releases) {
        const assets = (rel as Record<string, unknown>)['assets'];
        if (Array.isArray(assets)) {
          for (const a of assets) downloads += asNumber((a as Record<string, unknown>)['download_count']);
        }
      }
      metrics.downloads = downloads;
    }
    return metrics;
  }

  /** オープンIssue/PR一覧(トリアージ対象) */
  async openItems(repo: string): Promise<GithubIssueSummary[]> {
    const raw = parseJson(
      await this.run(['api', `repos/${repo}/issues?state=open&per_page=50`]).catch(() => '[]'),
    );
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
      const rec = item as Record<string, unknown>;
      const labels = Array.isArray(rec['labels'])
        ? (rec['labels'] as Record<string, unknown>[]).map((l) => String(l['name'] ?? ''))
        : [];
      return {
        number: asNumber(rec['number']),
        title: String(rec['title'] ?? ''),
        author: String((rec['user'] as Record<string, unknown> | undefined)?.['login'] ?? ''),
        kind: rec['pull_request'] !== undefined ? ('pr' as const) : ('issue' as const),
        body: String(rec['body'] ?? '').slice(0, 4000),
        labels,
      };
    });
  }

  /** PRのdiff(トリアージのレビュー対象。長大なら先頭を切る) */
  async prDiff(repo: string, number: number): Promise<string> {
    const diff = await this.run(['pr', 'diff', String(number), '-R', repo]).catch((e: unknown) => {
      return `(diff取得失敗: ${e instanceof Error ? e.message : String(e)})`;
    });
    return diff.length > 60_000 ? `${diff.slice(0, 60_000)}\n…(以降省略)` : diff;
  }

  /** PRのCI結果(check-runs)。レジストリPRの統合表示用 */
  async checkRuns(repo: string, number: number): Promise<{ name: string; status: string; conclusion: string }[]> {
    const pr = parseJson(await this.run(['api', `repos/${repo}/pulls/${number}`]).catch(() => 'null'));
    const sha = pr !== null && typeof pr === 'object' ? String((pr as Record<string, unknown>)['head'] !== undefined ? ((pr as Record<string, unknown>)['head'] as Record<string, unknown>)['sha'] ?? '' : '') : '';
    if (sha === '') return [];
    const runs = parseJson(
      await this.run(['api', `repos/${repo}/commits/${sha}/check-runs`]).catch(() => 'null'),
    );
    const list = runs !== null && typeof runs === 'object' ? (runs as Record<string, unknown>)['check_runs'] : null;
    if (!Array.isArray(list)) return [];
    return list.map((r) => {
      const rec = r as Record<string, unknown>;
      return {
        name: String(rec['name'] ?? ''),
        status: String(rec['status'] ?? ''),
        conclusion: String(rec['conclusion'] ?? ''),
      };
    });
  }
}

/**
 * アダプタ本体。executor は protocol.ts の岩戸ゲートに封印される。
 * 夜間実装ルール: executeの実発行はテストではモックのみ(NIGHT_TASKS6)。
 */
export function createGithubAdapter(run: GhRunner, ghAvailable: () => boolean): AdapterRuntime {
  return {
    id: 'github',
    capabilities: {
      read: true,
      search: true,
      draft: true,
      execute: ['comment', 'label', 'merge', 'release'],
    },
    compliance:
      'GitHub APIの正規利用(gh CLI認証)。コメント/ラベル/マージ/リリースは承認後のみ。リリースは常に下書き(draft)で作成し、公開は人間がGitHub上で行う',
    availability: () =>
      Promise.resolve(
        ghAvailable()
          ? { available: true }
          : { available: false, detail: 'gh CLI が見つからない(winget install GitHub.cli で導入)' },
      ),
    executor: async (action, params) => {
      const repo = String(params['repo'] ?? '');
      const number = String(params['number'] ?? '');
      if (action === 'comment') {
        const body = String(params['body'] ?? '');
        const kind = params['kind'] === 'pr' ? 'pr' : 'issue';
        await run([kind, 'comment', number, '-R', repo, '--body', body]);
        return `${repo}#${number} へコメントを投稿した`;
      }
      if (action === 'label') {
        const labels = Array.isArray(params['labels']) ? (params['labels'] as string[]) : [];
        await run(['issue', 'edit', number, '-R', repo, '--add-label', labels.join(',')]);
        return `${repo}#${number} にラベル ${labels.join(',')} を付与した`;
      }
      if (action === 'merge') {
        await run(['pr', 'merge', number, '-R', repo, '--merge']);
        return `${repo}#${number} をマージした`;
      }
      if (action === 'release') {
        // M37: リリースノート下書き → GitHub Release。公開(publish)は人間がGitHub上で行うため
        // 作成は必ず --draft。既存タグがあれば本文の差し替えのみ(下書き状態は変えない)
        const tag = String(params['tag'] ?? '');
        const title = String(params['title'] ?? tag);
        const body = String(params['body'] ?? '');
        const exists = await run(['release', 'view', tag, '-R', repo, '--json', 'tagName']).then(
          () => true,
          () => false,
        );
        if (exists) {
          await run(['release', 'edit', tag, '-R', repo, '--title', title, '--notes', body]);
          return `${repo} のリリース ${tag} の本文を更新した(公開状態は変更していない)`;
        }
        await run(['release', 'create', tag, '-R', repo, '--title', title, '--notes', body, '--draft']);
        return `${repo} にリリース ${tag} を下書きで作成した(公開はGitHub上であなたが行う)`;
      }
      throw new Error(`未知のアクション: ${action}`);
    },
  };
}
