import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * M91-8(改善1): 公開済みツールの控え。
 *
 * レジストリへPRを出したツールを記録する。目的はただ一つ — **同じツールで2度目のPRを
 * 誤って出させない**こと。公開ボタンは押した直後もそのまま押せてしまい、PRがマージ
 * されて index.json に載るまでは重複ガードが効かない(その間に何度でも出せてしまう)。
 * ここに控えを残し、UI側は「公開済み」を出してボタンを止め、IPC側は下見の時点で撥ねる。
 */

export interface PublishedRecord {
  /** 提出したPRのURL(利用者が状況を追える) */
  url: string;
  /** 提出時刻(ISO8601) */
  ts: string;
}

export class PublishedStore {
  private cache: Record<string, PublishedRecord> | null = null;

  constructor(private readonly file: string) {}

  private load(): Record<string, PublishedRecord> {
    if (this.cache !== null) return this.cache;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      this.cache = typeof raw === 'object' && raw !== null ? (raw as Record<string, PublishedRecord>) : {};
    } catch {
      // ファイルが無い/壊れている = まだ何も公開していない、として扱う(公開を止めない)
      this.cache = {};
    }
    return this.cache;
  }

  has(toolName: string): boolean {
    return this.load()[toolName] !== undefined;
  }

  get(toolName: string): PublishedRecord | undefined {
    return this.load()[toolName];
  }

  list(): Record<string, PublishedRecord> {
    return { ...this.load() };
  }

  record(toolName: string, rec: PublishedRecord): void {
    const next = { ...this.load(), [toolName]: rec };
    this.cache = next;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8');
  }

  /** 控えを外す(取り下げ・別名で出し直したい時。UIからは今は使わないが、手当てのため残す) */
  forget(toolName: string): void {
    const cur = this.load();
    if (cur[toolName] === undefined) return;
    const next = { ...cur };
    delete next[toolName];
    this.cache = next;
    if (existsSync(this.file)) writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8');
  }
}
