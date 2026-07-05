import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionMeta } from '../../shared/types';
import { compactHistory } from '../agent/compaction';
import type { ChatMessage, ContentBlock, ImageAttachment, LLMProvider } from '../providers/types';

/**
 * M12-1: セッション永続化。userData/sessions/<id>.json に会話履歴を保存し、
 * アプリ再起動後の再開を可能にする。
 * - 書き込みは tmp → rename のアトミック方式(書きかけファイルで壊れない)
 * - ロード時に末尾の未完了 tool_use を合成 tool_result で閉じる(API 400 対策)
 * - 履歴JSONが上限を超えるときは既存 compaction で畳んでから保存する
 * - secrets はそもそも履歴(ChatMessage)に入らない設計。このファイルも参照しない
 */

export const SESSION_SCHEMA_VERSION = 1;
/** 履歴JSONのサイズ上限。超えたら保存前に古いターンを要約へ畳む */
export const MAX_SESSION_JSON_BYTES = 8 * 1024 * 1024;
export const INTERRUPTED_RESULT_TEXT = 'アプリ再起動により中断';
/** M14-1: セッションあたりの画像合計上限。超過時は古い画像からテキスト化 */
export const MAX_IMAGE_BYTES_PER_SESSION = 50 * 1024 * 1024;

export interface SessionData {
  version: typeof SESSION_SCHEMA_VERSION;
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  history: ChatMessage[];
}

// randomUUID 形式のみ受け付ける(renderer 入力によるパストラバーサル防止)
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

export function historyJsonBytes(history: ChatMessage[]): number {
  return Buffer.byteLength(JSON.stringify(history), 'utf8');
}

/**
 * クラッシュ・強制終了で tool_use に対応する tool_result が欠けた履歴を修復する。
 * 欠損分を isError の合成 tool_result で閉じ、修復したブロック数を返す。
 * (tool_result は直後の user メッセージに無いと次リクエストで API が 400 を返す)
 */
export function repairDanglingToolUse(history: ChatMessage[]): number {
  let repaired = 0;
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!msg || msg.role !== 'assistant') continue;
    const uses = msg.content.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (uses.length === 0) continue;

    const next = history[i + 1];
    const nextIsResultMsg =
      next !== undefined &&
      next.role === 'user' &&
      next.content.some((b) => b.type === 'tool_result');
    const existing = new Set(
      nextIsResultMsg
        ? next.content
            .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
            .map((b) => b.toolUseId)
        : [],
    );
    const missing = uses.filter((u) => !existing.has(u.id));
    if (missing.length === 0) continue;

    const synthetic: ContentBlock[] = missing.map((u) => ({
      type: 'tool_result',
      toolUseId: u.id,
      content: INTERRUPTED_RESULT_TEXT,
      isError: true,
    }));
    if (nextIsResultMsg && next) {
      next.content.push(...synthetic);
    } else {
      history.splice(i + 1, 0, { role: 'user', content: synthetic });
    }
    repaired += missing.length;
  }
  return repaired;
}

/**
 * 履歴JSONがサイズ上限を超えていたら、既存 compaction(LLM要約)で畳む。
 * 上限超過時は必ず畳みたいため閾値1で強制する。畳んだら true。
 */
export async function foldHistoryIfOversize(
  provider: LLMProvider,
  history: ChatMessage[],
  maxBytes: number = MAX_SESSION_JSON_BYTES,
): Promise<boolean> {
  if (historyJsonBytes(history) <= maxBytes) return false;
  return compactHistory(provider, history, { thresholdTokens: 1 });
}

function isChatMessage(v: unknown): v is ChatMessage {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return (rec['role'] === 'user' || rec['role'] === 'assistant') && Array.isArray(rec['content']);
}

function isSessionData(v: unknown): v is SessionData {
  if (typeof v !== 'object' || v === null) return false;
  const rec = v as Record<string, unknown>;
  return (
    rec['version'] === SESSION_SCHEMA_VERSION &&
    typeof rec['id'] === 'string' &&
    typeof rec['title'] === 'string' &&
    typeof rec['workspace'] === 'string' &&
    typeof rec['createdAt'] === 'string' &&
    typeof rec['updatedAt'] === 'string' &&
    Array.isArray(rec['history']) &&
    (rec['history'] as unknown[]).every(isChatMessage)
  );
}

/** 履歴中の全画像(添付+tool_result内)を列挙する(古い順) */
function collectImages(history: ChatMessage[]): ImageAttachment[] {
  const out: ImageAttachment[] = [];
  for (const m of history) {
    for (const b of m.content) {
      if (b.type === 'image') out.push(b);
      else if (b.type === 'tool_result' && b.images) out.push(...b.images);
    }
  }
  return out;
}

function imageBytes(img: ImageAttachment): number {
  // base64 → 実バイト概算
  return Math.floor(img.data.length * 0.75);
}

/**
 * M14-1: セッションあたり50MB超過時、古い画像から「[画像: 説明]」テキストへ置換する。
 * 呼び出し側(live履歴)を直接書き換える — メモリとディスクの整合を保つため。
 * 添付画像ブロックは同位置で text ブロックへ、tool_result 画像は images から除去し本文へ注記。
 * ブロック数・ペア構造は不変。戻り値はテキスト化した枚数
 */
export function evictOldImagesOverLimit(
  history: ChatMessage[],
  maxBytes: number = MAX_IMAGE_BYTES_PER_SESSION,
): number {
  let total = collectImages(history).reduce((sum, img) => sum + imageBytes(img), 0);
  if (total <= maxBytes) return 0;
  let evicted = 0;
  for (const m of history) {
    if (total <= maxBytes) break;
    for (let j = 0; j < m.content.length && total > maxBytes; j++) {
      const b = m.content[j]!;
      if (b.type === 'image') {
        total -= imageBytes(b);
        m.content[j] = { type: 'text', text: `[画像: ${b.description ?? b.mediaType}](保存上限で破棄)` };
        evicted++;
      } else if (b.type === 'tool_result' && b.images && b.images.length > 0) {
        while (b.images.length > 0 && total > maxBytes) {
          const img = b.images.shift()!;
          total -= imageBytes(img);
          b.content = `${b.content}\n[画像: ${img.description ?? img.mediaType}](保存上限で破棄)`;
          evicted++;
        }
        if (b.images.length === 0) delete b.images;
      }
    }
  }
  return evicted;
}

export class SessionStore {
  /** save の直列化(並行 save で tmp/rename が交錯しないように) */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private blobPath(hash: string): string {
    return join(this.dir, 'blobs', `${hash}.bin`);
  }

  /**
   * 画像本体を sessions/blobs/ へ外出しした保存用コピーを作る(入力は変更しない)。
   * ブロックは { data: '', blobRef: <sha256> } になり、JSONの肥大を防ぐ
   */
  private async externalizeImages(history: ChatMessage[]): Promise<ChatMessage[]> {
    const writeBlob = async (img: ImageAttachment): Promise<ImageAttachment> => {
      if (img.data === '') return img; // 既に外出し済み(ロード後未変更)
      const bytes = Buffer.from(img.data, 'base64');
      const hash = createHash('sha256').update(bytes).digest('hex');
      await mkdir(join(this.dir, 'blobs'), { recursive: true });
      await writeFile(this.blobPath(hash), bytes).catch((err) => {
        throw new Error(`画像blobの保存失敗: ${err instanceof Error ? err.message : err}`);
      });
      const out: ImageAttachment = { ...img, data: '', blobRef: hash };
      return out;
    };
    return Promise.all(
      history.map(async (m) => ({
        ...m,
        content: await Promise.all(
          m.content.map(async (b): Promise<ContentBlock> => {
            if (b.type === 'image') return { ...(await writeBlob(b)), type: 'image' };
            if (b.type === 'tool_result' && b.images && b.images.length > 0) {
              return { ...b, images: await Promise.all(b.images.map(writeBlob)) };
            }
            return b;
          }),
        ),
      })),
    );
  }

  /** blobRef の画像本体を読み戻す(欠損blobは置換テキスト化して壊れないようにする) */
  private async inlineImages(history: ChatMessage[]): Promise<void> {
    const load = async (img: ImageAttachment): Promise<ImageAttachment | null> => {
      if (img.data !== '' || !img.blobRef || !/^[0-9a-f]{64}$/.test(img.blobRef)) {
        return img.data !== '' ? img : null;
      }
      try {
        const bytes = await readFile(this.blobPath(img.blobRef));
        return { ...img, data: bytes.toString('base64') };
      } catch {
        return null; // blob欠損
      }
    };
    for (const m of history) {
      for (let j = 0; j < m.content.length; j++) {
        const b = m.content[j]!;
        if (b.type === 'image') {
          const loaded = await load(b);
          if (loaded) m.content[j] = { ...loaded, type: 'image' };
          else m.content[j] = { type: 'text', text: `[画像: ${b.description ?? b.mediaType}](本体が見つからない)` };
        } else if (b.type === 'tool_result' && b.images && b.images.length > 0) {
          const kept: ImageAttachment[] = [];
          for (const img of b.images) {
            const loaded = await load(img);
            if (loaded) kept.push(loaded);
            else b.content = `${b.content}\n[画像: ${img.description ?? img.mediaType}](本体が見つからない)`;
          }
          if (kept.length > 0) b.images = kept;
          else delete b.images;
        }
      }
    }
  }

  save(data: SessionData): Promise<void> {
    const run = async (): Promise<void> => {
      if (!isValidSessionId(data.id)) throw new Error(`不正なセッションID: ${data.id}`);
      await mkdir(this.dir, { recursive: true });
      // M14-1: 50MB超過の古い画像をテキスト化(live履歴側も同期して整合を保つ)
      evictOldImagesOverLimit(data.history);
      // 画像本体は blobs/ へ外出しした保存用コピーをJSON化(liveは base64 のまま)
      const persisted = { ...data, history: await this.externalizeImages(data.history) };
      const tmp = `${this.file(data.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(persisted), 'utf8');
      // rename は同一ボリューム内でアトミック。書きかけの本体ファイルは生じない
      await rename(tmp, this.file(data.id));
    };
    const p = this.queue.then(run, run);
    this.queue = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /** 存在しない・壊れている・未知バージョンは null(呼び出し側でユーザー向けメッセージ化) */
  async load(id: string): Promise<SessionData | null> {
    if (!isValidSessionId(id)) return null;
    let raw: string;
    try {
      raw = await readFile(this.file(id), 'utf8');
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isSessionData(parsed)) return null;
    repairDanglingToolUse(parsed.history);
    await this.inlineImages(parsed.history);
    return parsed;
  }

  async list(): Promise<SessionMeta[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.slice(0, -'.json'.length);
      if (!isValidSessionId(id)) continue;
      try {
        const parsed: unknown = JSON.parse(await readFile(join(this.dir, f), 'utf8'));
        if (isSessionData(parsed)) {
          metas.push({
            id: parsed.id,
            title: parsed.title,
            workspace: parsed.workspace,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
            messageCount: parsed.history.length,
          });
        }
      } catch {
        // 壊れたファイルは一覧から除外(loadでもnullになる)
      }
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas;
  }

  async delete(id: string): Promise<void> {
    if (!isValidSessionId(id)) return;
    await rm(this.file(id), { force: true });
  }
}
