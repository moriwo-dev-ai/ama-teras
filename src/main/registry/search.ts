import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeToolName } from '../tools/name';

/**
 * M28-3: 「作る前に探す」— コミュニティレジストリの索引検索とダウンロード。
 * index.json のスキーマはレジストリリポジトリ(amateras-registry)と整合させること:
 *   { "registryVersion": 1, "plugins": [ { name, description, version, author,
 *     verified, path, files: [...] } ] }
 * ネット不達・不正応答は null / 空配列で返し、呼び出し側は静かに生成フローへ
 * フォールバックする(レジストリの不調で自己進化を止めない)。
 */

export interface RegistryIndexEntry {
  name: string;
  description: string;
  version: string;
  author: string;
  /** レジストリCI+人間承認を通過した「検証済み」か(未検証は既定非表示の設計) */
  verified: boolean;
  /** レジストリルートからの相対ディレクトリ(例 "plugins/text_stats") */
  path: string;
  /** ディレクトリ内のファイル名(<name>.ts / <name>.test.ts / manifest.json) */
  files: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseEntry(raw: unknown): RegistryIndexEntry | null {
  if (!isRecord(raw)) return null;
  const { name, description, version, author, verified, path, files } = raw;
  if (!isSafeToolName(name)) return null;
  if (typeof description !== 'string' || typeof version !== 'string') return null;
  if (typeof path !== 'string' || path === '' || path.includes('..')) return null;
  if (!Array.isArray(files) || files.length === 0) return null;
  // パストラバーサル防止: ファイル名は区切り無しの単純名のみ受け入れる
  const safeFiles = files.filter(
    (f): f is string => typeof f === 'string' && f !== '' && !/[\\/]|\.\./.test(f),
  );
  if (safeFiles.length !== files.length) return null;
  return {
    name,
    description,
    version,
    author: typeof author === 'string' ? author : '',
    verified: verified === true,
    path,
    files: safeFiles,
  };
}

/** index.json を取得してパースする。失敗は null(静かにスキップ) */
export async function fetchRegistryIndex(
  registryUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<RegistryIndexEntry[] | null> {
  try {
    const base = registryUrl.replace(/\/+$/, '');
    const res = await fetchFn(`${base}/index.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body) || !Array.isArray(body['plugins'])) return null;
    const out: RegistryIndexEntry[] = [];
    for (const raw of body['plugins']) {
      const e = parseEntry(raw);
      if (e !== null) out.push(e);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * 依頼文(description + expectedIO)との簡易マッチング。
 * 日本語は空白で区切られないため、素性を「英数語(長さ2+)+CJK連続部分の文字バイグラム」で
 * 抽出し、エントリ側素性と依頼文側素性の重なり数でスコアリングする(スコア降順)。
 * 形態素解析は持たないため取りこぼし・弱い偽陽性はあり得る — 候補は必ずユーザー承諾を
 * 挟むので偽陽性は無害(断れば従来どおり生成される)
 */
export function matchRegistryEntries(
  entries: RegistryIndexEntry[],
  query: string,
): { entry: RegistryIndexEntry; score: number }[] {
  const queryFeatures = new Set(features(query));
  const scored: { entry: RegistryIndexEntry; score: number }[] = [];
  const q = query.toLowerCase();
  for (const entry of entries) {
    let score = 0;
    for (const f of new Set(features(`${entry.name} ${entry.description}`))) {
      if (queryFeatures.has(f)) score += 1;
    }
    // ツール名そのものが依頼文に出てくる場合は強いシグナル
    if (q.includes(entry.name.toLowerCase())) score += 5;
    if (score > 0) scored.push({ entry, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

/** 英数語(len>=2)+ CJK連続部分の文字バイグラムを素性として列挙する */
function features(text: string): string[] {
  const lower = text.toLowerCase();
  const out: string[] = [];
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);
  for (const m of lower.matchAll(/[ぁ-んァ-ヶ一-龠ー]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * 候補プラグインのファイル一式を destDir へダウンロードする。
 * ファイル名は index 検証済み(単純名のみ)。1ファイルでも失敗したら ok:false
 */
export async function downloadRegistryPlugin(
  registryUrl: string,
  entry: RegistryIndexEntry,
  destDir: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; message: string }> {
  const base = registryUrl.replace(/\/+$/, '');
  try {
    await mkdir(destDir, { recursive: true });
    for (const file of entry.files) {
      const url = `${base}/${entry.path.replace(/^\/+|\/+$/g, '')}/${file}`;
      const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, message: `ダウンロード失敗(HTTP ${res.status}): ${url}` };
      await writeFile(join(destDir, file), Buffer.from(await res.arrayBuffer()));
    }
    return { ok: true, message: `ダウンロード完了: ${entry.files.length}ファイル` };
  } catch (err) {
    return { ok: false, message: `ダウンロード失敗: ${err instanceof Error ? err.message : String(err)}` };
  }
}
