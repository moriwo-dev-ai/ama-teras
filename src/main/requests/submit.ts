import type { CoreRequest } from '../../shared/types';
import { GitHubClient, repoFromRegistryUrl, type FetchLike, type RepoRef } from '../registry/github';
import { scanForLeaks } from '../registry/leakScan';

/**
 * M91-3: 要望をIssueとして届ける。守ること:
 *  - 送るのは**コア/UIの話だけ**(ツールで解決できるものはツールを作る。要望にしない)
 *  - 送信前に全文を人間が読む(岩戸の掟。AMA-teras が書いた要望も例外ではない)
 *  - 秘密・ローカルパスは機械が止める(要望文には作業ログが混じりやすい=事故の温床)
 *  - 既存Issueを検索して重複を避ける(同じ話が10本立つと、誰も読まなくなる)
 */

export function repoFromUrl(url: string): RepoRef | null {
  return repoFromRegistryUrl(url);
}

/**
 * M91-7: 要望の種別を Issue 本文に残す機械マーカーの接頭辞。
 * ラベルは非コラボレータのIssueでは剥がされるので、これが KUEBIKO の主判定になる
 * (例: `amateras-request:ui` / `amateras-request:core`)
 */
export const REQUEST_MARKER_PREFIX = 'amateras-request:';

export interface RequestIssue {
  title: string;
  body: string;
  labels: string[];
  leaks: string[];
}

export function buildRequestIssue(req: CoreRequest, appVersion: string): RequestIssue {
  const label = req.kind === 'core' ? 'request:core' : 'request:ui';
  const who =
    req.source === 'agent'
      ? 'AMA-teras 自身が、作業中にコア/UIの制約に当たって書いた要望です(人間が全文を確認して送信しています)。'
      : 'AMA-teras の利用者が書いた要望です。';
  const body = [
    req.body,
    '',
    '---',
    `- 種別: ${req.kind === 'core' ? '本体(core)' : 'UI(renderer)'}`,
    `- 出どころ: ${req.source === 'agent' ? 'AMA-teras(自動起票)' : '人間'}`,
    `- アプリ版: ${appVersion}`,
    '',
    who,
    // M91-7: 機械可読マーカー(HTMLコメント=表示されない)。
    // **非コラボレータが立てたIssueはラベルがGitHubに剥がされる**ため、KUEBIKO はラベルに加えて
    // これで種別を判定する(外部貢献者の要望を取りこぼさないため)
    `<!-- ${REQUEST_MARKER_PREFIX}${req.kind} -->`,
  ].join('\n');
  return {
    title: req.title,
    body,
    labels: [label],
    leaks: [...scanForLeaks(req.title), ...scanForLeaks(req.body)].map((l) => `${l.line}行目: ${l.detail}`),
  };
}

export function requestPreviewText(issue: RequestIssue, repo: RepoRef): string {
  return [
    `# 要望を送る先: https://github.com/${repo.owner}/${repo.repo}`,
    `# ラベル: ${issue.labels.join(', ')}`,
    '',
    `## ${issue.title}`,
    '',
    issue.body,
  ].join('\n');
}

/** 似た要望が既に出ていないか(タイトルの語で検索。完璧は狙わず、明白な重複を止める) */
export async function findSimilarIssues(
  token: string,
  repo: RepoRef,
  issue: RequestIssue,
  fetchFn?: FetchLike,
): Promise<{ title: string; url: string; number: number }[]> {
  const gh = new GitHubClient({ token, ...(fetchFn ? { fetchFn } : {}) });
  // 記号を落とし、長めの語だけを残す(短い語で検索すると全件が返る)
  const words = issue.title
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 6);
  if (words.length === 0) return [];
  try {
    return await gh.searchIssues(repo, `${issue.labels[0] !== undefined ? `label:${issue.labels[0]} ` : ''}${words.join(' ')}`);
  } catch {
    // 検索できなくても提出はできる(重複チェックは「できたら止める」もの)
    return [];
  }
}

export async function submitRequest(
  token: string,
  repo: RepoRef,
  issue: RequestIssue,
  fetchFn?: FetchLike,
): Promise<{ ok: boolean; message: string; url?: string }> {
  if (issue.leaks.length > 0) {
    return { ok: false, message: `機械チェックで秘密情報らしきものを検出したため中止:\n${issue.leaks.join('\n')}` };
  }
  const gh = new GitHubClient({ token, ...(fetchFn ? { fetchFn } : {}) });
  const created = await gh.createIssue(repo, issue.title, issue.body, issue.labels);
  return { ok: true, message: `要望を提出しました(#${created.number}): ${created.url}`, url: created.url };
}
