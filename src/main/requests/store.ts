import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CoreRequest, CoreRequestKind, CoreRequestSource } from '../../shared/types';

/**
 * M91-3: 本体(コア/UI)への要望。**ツールと違い、コアは自分の機体で書き換えない**
 * (全員が同じコア/UIを使うのがこの設計の前提)。代わりに、行き止まりに当たったことを
 * 開発リポジトリへ届ける口を持つ。
 *
 * ここは「下書きの置き場」。送信は必ず人間の全文承認を経る(送信前に消すこともできる)。
 * 下書きの出どころは2つ:
 *   - human: 人が書いた要望
 *   - agent: AMA-teras 自身が「コア/UIの制約に当たった」と気づいて書いた要望
 *            (request_core_change ツール。ツールで解決できないことだけがここに来る)
 */
/**
 * M99-5: 要望の kind → 進化スコープの対応。
 * ui=画面(renderer) / core=本体。tool にしない — 「UIを直して」がプラグイン生成になると
 * 永久に的を外す(KUEBIKO の M91-4 と同じ理由)
 */
export function requestScope(kind: CoreRequestKind): 'renderer' | 'core' {
  return kind === 'ui' ? 'renderer' : 'core';
}

export class RequestStore {
  private items: CoreRequest[] = [];
  private loaded = false;

  constructor(private readonly file: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.file)) return;
    try {
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(raw)) this.items = raw as CoreRequest[];
    } catch {
      /* 壊れていたら空から始める(要望が消えても本体は動く) */
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.items, null, 2), 'utf8');
  }

  async list(): Promise<CoreRequest[]> {
    await this.load();
    return [...this.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<CoreRequest | undefined> {
    await this.load();
    return this.items.find((r) => r.id === id);
  }

  async create(input: {
    kind: CoreRequestKind;
    title: string;
    body: string;
    source: CoreRequestSource;
    createdAt: string;
  }): Promise<CoreRequest> {
    await this.load();
    const req: CoreRequest = {
      id: `${input.createdAt}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      kind: input.kind,
      title: input.title.trim().slice(0, 120),
      body: input.body.trim().slice(0, 8000),
      source: input.source,
      status: 'draft',
      createdAt: input.createdAt,
    };
    this.items.push(req);
    await this.persist();
    return req;
  }

  async update(id: string, patch: Partial<CoreRequest>): Promise<CoreRequest | undefined> {
    await this.load();
    const req = this.items.find((r) => r.id === id);
    if (req === undefined) return undefined;
    Object.assign(req, patch);
    await this.persist();
    return req;
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    const before = this.items.length;
    this.items = this.items.filter((r) => r.id !== id);
    if (this.items.length === before) return false;
    await this.persist();
    return true;
  }
}
