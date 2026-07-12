import type { UpdateInfo } from '../../shared/types';

/**
 * M42-1: アプリ本体の更新確認。
 * これまで更新の導線が一切無く、クローンしてくれた人は git pull しない限り新機能に
 * 気づけなかった。ここでやるのは **通知だけ**(自動ダウンロード・自動インストールはしない。
 * 署名やインストーラの話が絡むうえ、勝手に本体を書き換えるのは思想に反する)。
 * ネット不達・不正応答・レート制限はすべて null(静かに何も出さない)。
 */

/** 'v1.2.3' / '1.2.3' → [1,2,3]。数値以外を含むタグは比較しない(null) */
export function parseVersion(tag: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** latest が current より新しいか。どちらか解釈できなければ false(=通知しない) */
export function isNewerVersion(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (l === null || c === null) return false;
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function checkForUpdate(
  currentVersion: string,
  releasesApiUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<UpdateInfo | null> {
  // 空文字 = 明示的に更新確認を無効化(オフライン運用・フォーク運用)
  if (releasesApiUrl.trim() === '') return null;
  try {
    const res = await fetchFn(releasesApiUrl, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    // ドラフト・プレリリースは通知しない(公開された安定版だけを勧める)
    if (body['draft'] === true || body['prerelease'] === true) return null;
    const tag = typeof body['tag_name'] === 'string' ? body['tag_name'] : '';
    if (tag === '') return null;
    const rawUrl = typeof body['html_url'] === 'string' ? body['html_url'] : '';
    // 外部から来たURLをそのまま openExternal に渡さない(http/https のみ)
    const url = /^https:\/\//.test(rawUrl) ? rawUrl : '';
    const name = typeof body['name'] === 'string' && body['name'] !== '' ? body['name'] : tag;
    return {
      current: currentVersion,
      latest: tag,
      url,
      name,
      newer: isNewerVersion(tag, currentVersion),
    };
  } catch {
    return null;
  }
}
