/**
 * M27-4: キルスイッチの土台。失効リストURL(設定可能・既定は空)を起動時にフェッチし、
 * 一致する導入済みプラグインを自動無効化する。ネットワーク不達・不正応答は静かにスキップ
 * (キルスイッチの不達でアプリを止めない)。
 *
 * 受け入れる形式(どちらでも可):
 *   { "revoked": [ { "name": "tool_x", "reason": "..." }, "tool_y" ] }
 *   [ { "name": "tool_x", "reason": "..." }, "tool_y" ]
 */

export interface RevokedEntry {
  name: string;
  reason: string;
}

function parseEntries(raw: unknown): RevokedEntry[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>)['revoked'])
      ? ((raw as Record<string, unknown>)['revoked'] as unknown[])
      : null;
  if (list === null) return [];
  const out: RevokedEntry[] = [];
  for (const item of list) {
    if (typeof item === 'string' && item !== '') {
      out.push({ name: item, reason: '失効リストに登録されている' });
    } else if (typeof item === 'object' && item !== null) {
      const rec = item as Record<string, unknown>;
      if (typeof rec['name'] === 'string' && rec['name'] !== '') {
        out.push({
          name: rec['name'],
          reason: typeof rec['reason'] === 'string' && rec['reason'] !== '' ? rec['reason'] : '失効リストに登録されている',
        });
      }
    }
  }
  return out;
}

/**
 * 失効リストを取得する。null = 取得失敗(静かにスキップ)。
 * fetchFn はテスト用注入(既定はグローバル fetch)
 */
export async function fetchRevocationList(
  url: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<RevokedEntry[] | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return parseEntries(body);
  } catch {
    return null;
  }
}
