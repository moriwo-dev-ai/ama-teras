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

/**
 * M42-3: レジストリで配布される神定義(index.json の gods[])。
 *   { id, name, description, engine, version, author, verified, path, file }
 * 神は「コード」ではなく定義データなので、配布もダウンロードも1ファイルで済む。
 * 取り込みは必ず岩戸ゲート(定義JSON全文の確認)を通る=無承認の追加は構造的に不可能。
 */
export interface RegistryGodEntry {
  id: string;
  name: string;
  description: string;
  engine: string;
  version: string;
  author: string;
  verified: boolean;
  /** レジストリルートからの相対ディレクトリ(例 "gods/saruta-hiko") */
  path: string;
  /** 定義JSONのファイル名(例 "saruta-hiko.json") */
  file: string;
}

function parseGodEntry(raw: unknown): RegistryGodEntry | null {
  if (!isRecord(raw)) return null;
  const { id, name, description, engine, version, author, verified, path, file } = raw;
  if (typeof id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(id)) return null;
  if (typeof name !== 'string' || name === '') return null;
  if (typeof engine !== 'string' || engine === '') return null;
  if (typeof path !== 'string' || path === '' || path.includes('..')) return null;
  // パストラバーサル防止: ファイル名は区切り無しの単純名のみ
  if (typeof file !== 'string' || file === '' || /[\\/]|\.\./.test(file)) return null;
  return {
    id,
    name,
    description: typeof description === 'string' ? description : '',
    engine,
    version: typeof version === 'string' ? version : '',
    author: typeof author === 'string' ? author : '',
    verified: verified === true,
    path,
    file,
  };
}

/** index.json を1回だけ取得する(plugins と gods は同じ索引に同居する) */
async function fetchIndexJson(
  registryUrl: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    const base = registryUrl.replace(/\/+$/, '');
    const res = await fetchFn(`${base}/index.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

/** index.json を取得してパースする。失敗は null(静かにスキップ) */
export async function fetchRegistryIndex(
  registryUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<RegistryIndexEntry[] | null> {
  const body = await fetchIndexJson(registryUrl, fetchFn, timeoutMs);
  if (body === null || !Array.isArray(body['plugins'])) return null;
  const out: RegistryIndexEntry[] = [];
  for (const raw of body['plugins']) {
    const e = parseEntry(raw);
    if (e !== null) out.push(e);
  }
  return out;
}

/**
 * M42-3: 神定義の索引。gods[] を持たない旧レジストリでも空配列(エラーにしない=
 * 索引側の移行を待たずにクライアントを配れる)
 */
export async function fetchRegistryGods(
  registryUrl: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<RegistryGodEntry[] | null> {
  const body = await fetchIndexJson(registryUrl, fetchFn, timeoutMs);
  if (body === null) return null;
  if (!Array.isArray(body['gods'])) return [];
  const out: RegistryGodEntry[] = [];
  for (const raw of body['gods']) {
    const e = parseGodEntry(raw);
    if (e !== null) out.push(e);
  }
  return out;
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
  return scoreByText(entries, query, (e) => ({ key: e.name, text: `${e.name} ${e.description}` }));
}

/** M42-3: 神定義の索引にも同じスコアラを使う(id/name/説明/エンジン名で当てる) */
export function matchGodEntries(
  entries: RegistryGodEntry[],
  query: string,
): { entry: RegistryGodEntry; score: number }[] {
  return scoreByText(entries, query, (e) => ({
    key: e.id,
    text: `${e.id} ${e.name} ${e.description} ${e.engine}`,
  }));
}

/**
 * M89: **「text_stats は不適合」と書くほど text_stats が選ばれていた**。
 *
 * 名前が依頼文に出てくると +5 の強いボーナスを付けていたが、**否定の文脈を見ていなかった**。
 * xlsx作成を頼むのに「text_stats はテキスト統計ツールなので不適合」と書けば書くほど、
 * text_stats が1位になる。却下しても、次の依頼文にまた名前を書くのでまた1位に戻ってくる。
 * 名前の言及は「欲しい」とは限らない。**「要らない」と言うためにも名前は出る**。
 */
const NEGATION_RE =
  /(不適合|不要|関係(が)?な|無関係|ではなく|ではない|じゃない|使わない|避け|以外|代わり|違う|ダメ|だめ|not |no |exclude|unrelated|instead of|rather than|except)/;

/** 依頼文の中で、その名前が否定的に語られているか(前後の窓だけを見る) */
export function mentionedNegatively(query: string, key: string): boolean {
  const q = query.toLowerCase();
  const k = key.toLowerCase();
  let from = 0;
  for (;;) {
    const at = q.indexOf(k, from);
    if (at < 0) return false;
    const window = q.slice(Math.max(0, at - 24), Math.min(q.length, at + k.length + 24)); // 近傍だけ
    if (NEGATION_RE.test(window)) return true; // 1箇所でも否定なら、望まれていないとみなす
    from = at + k.length;
  }
}

/**
 * M89: しきい値も無かった(score > 0 = バイグラムが1個かすっただけで候補になる)。
 * ただし単純にスコアを上げると、**本物の一致まで落ちる**(「文字数を数えたい」→ word_count は
 * 日本語のバイグラムしか手掛かりが無い)。点の高さではなく**証拠の質**で決める:
 * - 英数語(xlsx, excel など)が1つでも重なっていて、合計が足りている
 * - あるいは日本語のバイグラムが十分な本数(4本以上)重なっている
 * 「ツー」「ール」のような、どのツール説明にも出る断片が2〜3本かすっただけでは候補にしない
 */
const WORD_WEIGHT = 2;
const BIGRAM_WEIGHT = 1;
const NAME_BONUS = 5;
const MIN_SCORE = 3;
const MIN_BIGRAMS_ALONE = 4;

function scoreByText<T>(
  entries: T[],
  query: string,
  pick: (e: T) => { key: string; text: string },
): { entry: T; score: number }[] {
  const queryFeatures = new Set(features(query));
  const scored: { entry: T; score: number }[] = [];
  const q = query.toLowerCase();
  for (const entry of entries) {
    const { key, text } = pick(entry);
    // 「要らない」と名指しされたものは、どれだけ言葉が重なっても候補にしない
    // (否定文に出てくる語は、そのまま素性としても重なるため点が入ってしまう)
    if (key !== '' && mentionedNegatively(query, key)) continue;
    let score = 0;
    let words = 0;
    let bigrams = 0;
    for (const f of new Set(features(text))) {
      if (!queryFeatures.has(f)) continue;
      if (/^[a-z0-9_]+$/.test(f)) {
        words++;
        score += WORD_WEIGHT;
      } else {
        bigrams++;
        score += BIGRAM_WEIGHT;
      }
    }
    // 名前そのものが(否定なしで)依頼文に出てくる場合は強いシグナル
    const named = key !== '' && q.includes(key.toLowerCase());
    if (named) score += NAME_BONUS;
    const enough = named || (words >= 1 && score >= MIN_SCORE) || bigrams >= MIN_BIGRAMS_ALONE;
    if (enough && score >= MIN_SCORE) scored.push({ entry, score });
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

/**
 * M42-3: 神定義JSONを取得して返す(ディスクには書かない)。
 * 呼び出し側は必ず validateGodDefinition で検証し、岩戸ゲートの承認を通してから適用すること。
 * 索引と定義で id が食い違うものは受け付けない(索引を信じて別の神を入れられない)
 */
export async function downloadRegistryGod(
  registryUrl: string,
  entry: RegistryGodEntry,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<unknown | null> {
  const base = registryUrl.replace(/\/+$/, '');
  try {
    const url = `${base}/${entry.path.replace(/^\/+|\/+$/g, '')}/${entry.file}`;
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body) || body['id'] !== entry.id) return null;
    return body;
  } catch {
    return null;
  }
}
