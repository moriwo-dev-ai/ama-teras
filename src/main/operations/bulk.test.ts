import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bulkGroupKey, isLinkOnlyAdapter, MAX_LINKS_PER_OPEN } from '../../shared/operations';
import type { ApprovalBatch, AppConfig } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { DraftStore } from './amenoUzume';
import { OperationsManager } from './manager';
import { IwatoGate } from './protocol';
import { OpsThread } from './thread';
import type { GitRunner } from './adapters/zennRepo';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bulk-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fakeLLM: LLMProvider = {
  id: 'anthropic',
  async *complete(): AsyncGenerator<ProviderEvent> {
    yield { type: 'text_delta', text: '## 本文' };
    yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' } as ProviderEvent;
  },
};

const CREDS = JSON.stringify({ identifier: 'me.bsky.social', appPassword: 'xxxx-xxxx-xxxx-xxxx' });

describe('M39-1: 岩戸ゲートの一括承認(requestExecuteMany)', () => {
  it('承認ダイアログは1回。全件の全文がプレビューに並び、実行とauditは1件ずつ', async () => {
    const prompts: { target: string; preview: string }[] = [];
    const audits: { target: string; approved: boolean }[] = [];
    const gate = new IwatoGate(
      (req) => {
        prompts.push({ target: req.target, preview: req.preview });
        return Promise.resolve(true);
      },
      (e) => audits.push({ target: e.target, approved: e.approved }),
    );
    const exec = vi.fn(async (_a: string, p: Record<string, unknown>) => `followed ${String(p['handle'])}`);
    gate.register({
      id: 'bluesky',
      capabilities: { read: true, search: true, draft: false, execute: ['follow'] },
      compliance: 'test',
      executor: exec,
    });

    const { approved, results } = await gate.requestExecuteMany('bluesky', 'follow', [
      { id: 'i1', target: '@a', preview: 'aの理由', params: { handle: 'a' } },
      { id: 'i2', target: '@b', preview: 'bの理由', params: { handle: 'b' } },
      { id: 'i3', target: '@c', preview: 'cの理由', params: { handle: 'c' } },
    ]);

    expect(approved).toBe(true);
    expect(prompts).toHaveLength(1); // 承認は1回
    expect(prompts[0]?.target).toContain('3件');
    // 全件の全文が並ぶ(1件でも読めない状態で承認させない)
    for (const r of ['aの理由', 'bの理由', 'cの理由']) expect(prompts[0]?.preview).toContain(r);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(audits.filter((a) => a.approved)).toHaveLength(3); // auditは1件ずつ
  });

  it('途中の1件が失敗しても残りは続行し、部分成功を正直に返す', async () => {
    const gate = new IwatoGate(() => Promise.resolve(true), () => {});
    gate.register({
      id: 'bluesky',
      capabilities: { read: true, search: true, draft: false, execute: ['follow'] },
      compliance: 'test',
      executor: async (_a, p) => {
        if (p['handle'] === 'b') throw new Error('rate limited');
        return 'ok';
      },
    });
    const { results } = await gate.requestExecuteMany('bluesky', 'follow', [
      { id: 'i1', target: '@a', preview: '', params: { handle: 'a' } },
      { id: 'i2', target: '@b', preview: '', params: { handle: 'b' } },
      { id: 'i3', target: '@c', preview: '', params: { handle: 'c' } },
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1]?.detail).toContain('rate limited');
  });

  it('承認しなければ executor は1件も動かない(一括でも掟は同じ)', async () => {
    const exec = vi.fn(async () => 'ok');
    const gate = new IwatoGate(() => Promise.resolve(false), () => {});
    gate.register({
      id: 'bluesky',
      capabilities: { read: true, search: true, draft: false, execute: ['follow'] },
      compliance: 'test',
      executor: exec,
    });
    const { approved, results } = await gate.requestExecuteMany('bluesky', 'follow', [
      { id: 'i1', target: '@a', preview: '', params: { handle: 'a' } },
    ]);
    expect(approved).toBe(false);
    expect(results[0]?.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('M39-2: 一括の単位と行き先(媒体×アクション)', () => {
  const makeManager = (over: { zennRepoDir?: string; gitRunner?: GitRunner; bluesky?: boolean } = {}): OperationsManager =>
    new OperationsManager({
      userDataDir: dir,
      getConfig: () =>
        ({
          operations: {
            enabled: true,
            repos: ['o/r'],
            zennSlugs: [],
            ...(over.zennRepoDir !== undefined ? { zennRepoDir: over.zennRepoDir } : {}),
          },
        }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: () => Promise.resolve(true),
      bandProvider: () => fakeLLM,
      ghRunner: async () => '',
      ...(over.gitRunner !== undefined ? { gitRunner: over.gitRunner } : {}),
      ...(over.bluesky === true ? { getBlueskySecret: () => CREDS } : {}),
    });

  const batchWith = (items: ApprovalBatch['items']): ApprovalBatch => ({
    id: 'b1',
    ts: new Date().toISOString(),
    analysis: 'a',
    items,
  });

  it('X/はてブは岩戸を通さない: URLを返すだけ(アプリは何も発行しない)', async () => {
    expect(isLinkOnlyAdapter('x')).toBe(true);
    expect(isLinkOnlyAdapter('hatena')).toBe(true);
    expect(isLinkOnlyAdapter('bluesky')).toBe(false);

    const prompts: string[] = [];
    const manager = new OperationsManager({
      userDataDir: dir,
      getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
      audit: () => {},
      approvalPrompt: (req) => {
        prompts.push(req.adapterId);
        return Promise.resolve(true);
      },
      bandProvider: () => fakeLLM,
      ghRunner: async () => '',
    });
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(
      batchWith([
        {
          id: 'i1',
          kind: 'exec-action',
          title: 'X投稿1',
          detail: '',
          action: { adapterId: 'x', actionName: 'open-intent', target: 'X 投稿画面1', preview: '本文1', params: { url: 'https://x.com/intent/post?text=a' } },
          status: 'pending',
        },
        {
          id: 'i2',
          kind: 'exec-action',
          title: 'X投稿2',
          detail: '',
          action: { adapterId: 'x', actionName: 'open-intent', target: 'X 投稿画面2', preview: '本文2', params: { url: 'https://x.com/intent/post?text=b' } },
          status: 'pending',
        },
      ]),
    );

    const r = await manager.bulkRespond('b1', ['i1', 'i2'], true);
    expect(r.ok).toBe(true);
    expect(r.links?.map((l) => l.url)).toEqual([
      'https://x.com/intent/post?text=a',
      'https://x.com/intent/post?text=b',
    ]);
    // 岩戸ダイアログは出ない(発行しないので承認する対象が無い)
    expect(prompts).toHaveLength(0);
  });

  it('媒体×アクションが混在した一括は拒否される(承認の的が濁るため)', async () => {
    const manager = makeManager({ bluesky: true });
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(
      batchWith([
        {
          id: 'i1',
          kind: 'exec-action',
          title: 'follow',
          detail: '',
          action: { adapterId: 'bluesky', actionName: 'follow', target: '@a', preview: '', params: { handle: 'a' } },
          status: 'pending',
        },
        {
          id: 'i2',
          kind: 'exec-action',
          title: 'post',
          detail: '',
          action: { adapterId: 'bluesky', actionName: 'post', target: '投稿', preview: '', params: { text: 'x' } },
          status: 'pending',
        },
      ]),
    );
    const r = await manager.bulkRespond('b1', ['i1', 'i2'], true);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('一括できない');
    expect(bulkGroupKey('bluesky', 'follow')).not.toBe(bulkGroupKey('bluesky', 'post'));
  });

  it('Zenn記事の一括: 承認前に本文を起こし、published:false でコミットし、下書きは投稿済みになる', async () => {
    const repoDir = join(dir, 'zenn-content');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    const git = vi.fn<GitRunner>(async () => '');
    const manager = makeManager({ zennRepoDir: repoDir, gitRunner: git });
    await manager.status();
    const store = new DraftStore(join(dir, 'operations'));
    const [draft] = store.add([{ kind: 'article-outline', title: 'AMA-teras の記事', body: '## 章' }]);
    new OpsThread(join(dir, 'operations')).addBatch(
      batchWith([
        {
          id: 'i1',
          kind: 'exec-action',
          title: 'Zenn記事化',
          detail: '',
          action: {
            adapterId: 'zenn-repo',
            actionName: 'commit-article',
            target: 'zenn-content/articles/',
            preview: '## 章',
            params: { draftId: draft!.id },
          },
          status: 'pending',
        },
      ]),
    );

    const r = await manager.bulkRespond('b1', ['i1'], true);
    expect(r.ok).toBe(true);
    expect(r.detail).toBe('1件中1件成功');
    expect(git.mock.calls.map((c) => c[0][0])).toEqual(['add', 'commit', 'push']);
    // M57: Zennは published:false でのコミット = **まだ誰も読めない**。
    // posted(=公開された)ではなく staged(=公開待ち)。混ぜていたせいで、
    // 神議が「発信したのに反応が無い」と誤診していた
    const after = manager.listDrafts().find((d) => d.id === draft!.id);
    expect(after?.status).toBe('staged');
    expect(after?.media).toBe('zenn');
    // 本文の下書き(article-body)も残る
    expect(manager.listDrafts().some((d) => d.kind === 'article-body')).toBe(true);
  });

  it('却下の一括: 何も実行せず、全件が却下として記録される', async () => {
    const manager = makeManager({ bluesky: true });
    await manager.status();
    new OpsThread(join(dir, 'operations')).addBatch(
      batchWith([
        {
          id: 'i1',
          kind: 'exec-action',
          title: 'follow a',
          detail: '',
          action: { adapterId: 'bluesky', actionName: 'follow', target: '@a', preview: '', params: { handle: 'a' } },
          status: 'pending',
        },
      ]),
    );
    const r = await manager.bulkRespond('b1', ['i1'], false);
    expect(r.detail).toContain('却下');
    expect(r.results[0]?.ok).toBe(false);
  });

  it('リンクの開きすぎ防止: 上限は5件(超過分はUIが「続きを開く」で刻む)', () => {
    expect(MAX_LINKS_PER_OPEN).toBe(5);
  });

  /**
   * M74: 実害。スマホの承認ボタンは1枚でも bulkRespond を通るため、M69(batchRespond側の
   * 双子まとめ)が効いていなかった。神議が15分ごとに作り直した同じカードを人間が続けて叩き、
   * **5秒間に3本 Zenn へコミットされ、同じ記事が2本 公開リポジトリに載った**。
   * 本文生成に数秒かかる間、下書きの「投稿済み」印はまだ付かないので、
   * M43-2の重複ガードは競合で素通りできた。
   */
  it('同じ内容のカードが複数あっても、実行は1回だけ(双子には判断だけを反映)', async () => {
    const repoDir = join(dir, 'zenn-content');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    const git = vi.fn<GitRunner>(async () => '');
    const manager = makeManager({ zennRepoDir: repoDir, gitRunner: git });
    await manager.status();
    const store = new DraftStore(join(dir, 'operations'));
    const [draft] = store.add([{ kind: 'article-outline', title: '同じ記事', body: '## 章' }]);
    // 神議が3回作り直した、まったく同じカード
    const card = (id: string) => ({
      id,
      kind: 'exec-action' as const,
      title: 'Zenn記事化: 「同じ記事」',
      detail: '',
      action: {
        adapterId: 'zenn-repo',
        actionName: 'commit-article',
        target: 'zenn-content/articles/',
        preview: '## 章',
        params: { draftId: draft!.id },
      },
      status: 'pending' as const,
    });
    new OpsThread(join(dir, 'operations')).addBatch(batchWith([card('i1'), card('i2'), card('i3')]));

    // スマホの挙動を再現: 1枚ずつ、待たずに続けて叩く(指の速さで競合する)
    const [r1, r2, r3] = await Promise.all([
      manager.bulkRespond('b1', ['i1'], true),
      manager.bulkRespond('b1', ['i2'], true),
      manager.bulkRespond('b1', ['i3'], true),
    ]);

    // コミットは1回だけ(実機では3回走り、公開リポジトリに重複記事が残った)
    const commits = git.mock.calls.filter((c) => c[0]?.[0] === 'commit');
    expect(commits).toHaveLength(1);
    expect(git.mock.calls.filter((c) => c[0]?.[0] === 'push')).toHaveLength(1);
    // 残りは「実行された」と嘘をつかない
    expect([r1, r2, r3].filter((r) => r.results.some((x) => x.ok)).length).toBe(1);
  });
});
