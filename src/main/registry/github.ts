import { systemFetch } from '../providers/systemFetch';

/**
 * M91-2: GitHub REST の最小クライアント(fork → ブランチ → ファイル → PR / Issue)。
 * 依存は足さない。fetch は systemFetch(Electron net.fetch)経由 — 会社のプロキシや
 * Windows の証明書ストアの内側でも通るようにするため(M88 で同じ理由の事故を踏んでいる)
 */

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
}

export type FetchLike = typeof fetch;

/**
 * 設定の registryUrl から投稿先リポジトリを割り出す。
 * 既定は raw.githubusercontent.com/<owner>/<repo>/<branch>(公式レジストリ)。
 * 自前レジストリに向けている人は、その人のリポジトリへPRが出る(= registryUrl が唯一の宛先)
 */
export function repoFromRegistryUrl(url: string): RepoRef | null {
  const clean = url.replace(/\/+$/, '');
  const raw = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)/.exec(clean);
  if (raw) return { owner: raw[1]!, repo: raw[2]!, branch: raw[3]! };
  const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/.exec(clean);
  if (gh) return { owner: gh[1]!, repo: gh[2]!, branch: 'main' };
  return null;
}

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  fetchFn: FetchLike = systemFetch(),
): Promise<T> {
  const res = await fetchFn(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'AMA-teras',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) {
    const detail = ((): string => {
      try {
        const j = JSON.parse(text) as { message?: string; errors?: unknown };
        return j.message ?? text.slice(0, 200);
      } catch {
        return text.slice(0, 200);
      }
    })();
    throw new GitHubApiError(`GitHub API ${method} ${path} が失敗(${res.status}): ${detail}`, res.status);
  }
  return (text === '' ? {} : JSON.parse(text)) as T;
}

export interface GitHubClientOptions {
  token: string;
  fetchFn?: FetchLike;
  /** fork の作成待ちのポーリング(テストでは 0 にする) */
  waitMs?: number;
}

export class GitHubClient {
  private readonly fetchFn: FetchLike;
  private readonly waitMs: number;
  constructor(private readonly opts: GitHubClientOptions) {
    this.fetchFn = opts.fetchFn ?? systemFetch();
    this.waitMs = opts.waitMs ?? 2000;
  }

  private call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return api<T>(this.opts.token, method, path, body, this.fetchFn);
  }

  /** トークンの持ち主。権限不足・失効はここで分かる(投稿の途中で気づかないように、最初に確かめる) */
  async login(): Promise<string> {
    const me = await this.call<{ login: string }>('GET', '/user');
    return me.login;
  }

  /**
   * 自分のフォークを用意する(既にあればそれを返す)。
   * fork は非同期に作られるので、実際に見えるまで待つ
   */
  async ensureFork(target: RepoRef): Promise<RepoRef> {
    const me = await this.login();
    if (me === target.owner) return target; // 自分のリポジトリ = fork しない(直接ブランチを切る)
    try {
      await this.call<unknown>('GET', `/repos/${me}/${target.repo}`);
      return { owner: me, repo: target.repo, branch: target.branch };
    } catch (err) {
      if (!(err instanceof GitHubApiError) || err.status !== 404) throw err;
    }
    await this.call<unknown>('POST', `/repos/${target.owner}/${target.repo}/forks`);
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, this.waitMs));
      try {
        await this.call<unknown>('GET', `/repos/${me}/${target.repo}`);
        return { owner: me, repo: target.repo, branch: target.branch };
      } catch {
        /* まだ作成中 */
      }
    }
    throw new Error('フォークの作成が完了しない(時間をおいて再実行してください)');
  }

  /** upstream の最新 HEAD からブランチを切る(fork 側に作る) */
  async createBranch(upstream: RepoRef, fork: RepoRef, name: string): Promise<string> {
    const ref = await this.call<{ object: { sha: string } }>(
      'GET',
      `/repos/${upstream.owner}/${upstream.repo}/git/ref/heads/${upstream.branch}`,
    );
    const sha = ref.object.sha;
    await this.call<unknown>('POST', `/repos/${fork.owner}/${fork.repo}/git/refs`, {
      ref: `refs/heads/${name}`,
      sha,
    });
    return sha;
  }

  /** ファイルを1つ置く(既存なら上書き) */
  async putFile(
    fork: RepoRef,
    branch: string,
    path: string,
    content: string,
    message: string,
  ): Promise<void> {
    let sha: string | undefined;
    try {
      const cur = await this.call<{ sha: string }>(
        'GET',
        `/repos/${fork.owner}/${fork.repo}/contents/${path}?ref=${branch}`,
      );
      sha = cur.sha;
    } catch {
      /* 新規ファイル */
    }
    await this.call<unknown>('PUT', `/repos/${fork.owner}/${fork.repo}/contents/${path}`, {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      ...(sha === undefined ? {} : { sha }),
    });
  }

  async openPullRequest(
    upstream: RepoRef,
    fork: RepoRef,
    branch: string,
    title: string,
    body: string,
    draft: boolean,
  ): Promise<{ url: string; number: number }> {
    const pr = await this.call<{ html_url: string; number: number }>(
      'POST',
      `/repos/${upstream.owner}/${upstream.repo}/pulls`,
      {
        title,
        body,
        head: fork.owner === upstream.owner ? branch : `${fork.owner}:${branch}`,
        base: upstream.branch,
        draft,
      },
    );
    return { url: pr.html_url, number: pr.number };
  }

  /** 既存Issueの検索(重複提出を防ぐ)。q は GitHub の検索構文 */
  async searchIssues(repo: RepoRef, query: string): Promise<{ title: string; url: string; number: number }[]> {
    const q = encodeURIComponent(`repo:${repo.owner}/${repo.repo} is:issue ${query}`);
    const r = await this.call<{ items: { title: string; html_url: string; number: number }[] }>(
      'GET',
      `/search/issues?q=${q}&per_page=10`,
    );
    return r.items.map((i) => ({ title: i.title, url: i.html_url, number: i.number }));
  }

  async createIssue(
    repo: RepoRef,
    title: string,
    body: string,
    labels: string[],
  ): Promise<{ url: string; number: number }> {
    const issue = await this.call<{ html_url: string; number: number }>(
      'POST',
      `/repos/${repo.owner}/${repo.repo}/issues`,
      { title, body, labels },
    );
    return { url: issue.html_url, number: issue.number };
  }

  async getFile(repo: RepoRef, path: string): Promise<string | null> {
    try {
      const r = await this.call<{ content: string; encoding: string }>(
        'GET',
        `/repos/${repo.owner}/${repo.repo}/contents/${path}?ref=${repo.branch}`,
      );
      return Buffer.from(r.content, 'base64').toString('utf8');
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return null;
      throw err;
    }
  }
}
