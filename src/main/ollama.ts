import type { OllamaDetectResult } from '../shared/types';

/**
 * M114: ローカルOllamaの自動検出(長期戦略・ゲーミングPC層の入口)。
 *
 * 「Ollamaを入れている人」にとっての摩擦は、AMA-teras側でbaseURLとモデル名を
 * 手入力すること。検出できれば設定画面がワンクリック接続を提案できる。
 * - 検出先は既定ポートの http://127.0.0.1:11434 のみ(遠隔ホストの探索はしない)
 * - 失敗(未インストール/停止中/タイムアウト)は静かに available:false — エラーにしない
 */

export const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';
/** ワンクリック接続時に設定へ書く OpenAI互換 baseURL */
export const OLLAMA_OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';
const DETECT_TIMEOUT_MS = 1500;

/** /api/tags の応答からモデル名を取り出す(純関数。形が想定外なら空配列) */
export function parseOllamaTags(json: unknown): string[] {
  if (typeof json !== 'object' || json === null) return [];
  const models = (json as Record<string, unknown>)['models'];
  if (!Array.isArray(models)) return [];
  const names: string[] = [];
  for (const m of models) {
    if (typeof m !== 'object' || m === null) continue;
    const name = (m as Record<string, unknown>)['name'];
    if (typeof name === 'string' && name.trim() !== '') names.push(name.trim());
  }
  return names;
}

export async function detectOllama(
  fetchImpl: (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }> = fetch,
): Promise<OllamaDetectResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DETECT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(OLLAMA_TAGS_URL, { signal: ac.signal });
    if (!res.ok) return { available: false, models: [] };
    const models = parseOllamaTags(await res.json());
    return { available: true, models };
  } catch {
    return { available: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}
