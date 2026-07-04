import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionMeta } from '../../shared/types';
import { compactHistory } from '../agent/compaction';
import type { ChatMessage, ContentBlock, LLMProvider } from '../providers/types';

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

export class SessionStore {
  /** save の直列化(並行 save で tmp/rename が交錯しないように) */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  save(data: SessionData): Promise<void> {
    const run = async (): Promise<void> => {
      if (!isValidSessionId(data.id)) throw new Error(`不正なセッションID: ${data.id}`);
      await mkdir(this.dir, { recursive: true });
      const tmp = `${this.file(data.id)}.tmp`;
      await writeFile(tmp, JSON.stringify(data), 'utf8');
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
