import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoreRequest } from '../../shared/types';
import { RequestStore } from './store';
import { buildRequestIssue, findSimilarIssues, requestPreviewText, submitRequest } from './submit';

/**
 * M91-3: 要望チャネル。守りたいこと:
 *  - 下書きは溜まるだけで、勝手に出ていかない(送信はIPC側の全文承認のあと)
 *  - AMA-teras が書いた要望も、人が書いた要望も、同じ形で同じ門を通る
 *  - 秘密・ローカルパスは機械が止める(要望文には作業ログが混じりやすい)
 */

const REPO = { owner: 'moriwo-dev-ai', repo: 'ama-teras', branch: 'main' };

let dir: string;
let store: RequestStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-req-'));
  store = new RequestStore(join(dir, 'requests.json'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const draft = (over: Partial<CoreRequest> = {}): CoreRequest => ({
  id: 'r1',
  kind: 'ui',
  title: '進化タブに要望の一覧が欲しい',
  body: 'ツールでは画面を足せないため、UI側の変更が要る',
  source: 'agent',
  status: 'draft',
  createdAt: '2026-07-15T00:00:00.000Z',
  ...over,
});

describe('RequestStore(下書きの置き場)', () => {
  it('起票しても status は draft のまま(このツールは送信しない)', async () => {
    const r = await store.create({
      kind: 'core',
      title: 'x',
      body: 'y',
      source: 'agent',
      createdAt: '2026-07-15T00:00:00.000Z',
    });
    expect(r.status).toBe('draft');
    expect((await store.list())[0]?.id).toBe(r.id);
  });

  it('再読込しても残る(アプリを閉じても要望は消えない)', async () => {
    await store.create({ kind: 'ui', title: 'a', body: 'b', source: 'human', createdAt: '2026-07-15T00:00:00.000Z' });
    const reopened = new RequestStore(join(dir, 'requests.json'));
    expect(await reopened.list()).toHaveLength(1);
  });

  it('破棄できる(送る前にやめられる)', async () => {
    const r = await store.create({ kind: 'ui', title: 'a', body: 'b', source: 'human', createdAt: '2026-07-15T00:00:00.000Z' });
    expect(await store.remove(r.id)).toBe(true);
    expect(await store.list()).toHaveLength(0);
  });
});

describe('buildRequestIssue', () => {
  it('kind に応じたラベルを付け、出どころを本文に明記する', () => {
    const issue = buildRequestIssue(draft(), '1.2.1');
    expect(issue.labels).toEqual(['request:ui']);
    expect(issue.body).toContain('AMA-teras(自動起票)');
    expect(issue.body).toContain('1.2.1');
    expect(requestPreviewText(issue, REPO)).toContain('moriwo-dev-ai/ama-teras');
  });

  it('core は request:core ラベル', () => {
    expect(buildRequestIssue(draft({ kind: 'core' }), '1.2.1').labels).toEqual(['request:core']);
  });

  it('本文に機械マーカーを埋める(非コラボレータのラベル剥がれ対策。KUEBIKOの主判定)', () => {
    expect(buildRequestIssue(draft({ kind: 'ui' }), '1.2.1').body).toContain('<!-- amateras-request:ui -->');
    expect(buildRequestIssue(draft({ kind: 'core' }), '1.2.1').body).toContain('<!-- amateras-request:core -->');
  });

  it('秘密・ローカルパスを見つけたら leaks に出す(送信側が止める)', () => {
    const issue = buildRequestIssue(
      draft({ body: 'C:\\Users\\haru\\dev で試した。キーは sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaa' }),
      '1.2.1',
    );
    expect(issue.leaks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('submitRequest', () => {
  it('秘密が混じっていたら送らない', async () => {
    const issue = buildRequestIssue(draft({ body: 'token: ghp_0123456789abcdefghijklmnopqrstuvwx' }), '1.2.1');
    const r = await submitRequest('t', REPO, issue, (() => Promise.reject(new Error('呼ばれてはいけない'))) as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('秘密情報');
  });

  it('Issueを作ってURLを返す', async () => {
    const calls: string[] = [];
    const gh = ((url: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      const body = JSON.parse(init?.body ?? '{}') as { labels?: string[] };
      expect(body.labels).toEqual(['request:ui']);
      return Promise.resolve(
        new Response(JSON.stringify({ html_url: 'https://github.com/x/issues/3', number: 3 }), { status: 201 }),
      );
    }) as unknown as typeof fetch;
    const r = await submitRequest('t', REPO, buildRequestIssue(draft(), '1.2.1'), gh);
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://github.com/x/issues/3');
    expect(calls[0]).toBe('POST https://api.github.com/repos/moriwo-dev-ai/ama-teras/issues');
  });
});

describe('findSimilarIssues(重複を出さない)', () => {
  it('既存Issueを検索して返す', async () => {
    const gh = ((url: string) => {
      expect(url).toContain('/search/issues');
      expect(decodeURIComponent(url)).toContain('label:request:ui');
      return Promise.resolve(
        new Response(JSON.stringify({ items: [{ title: '同じ要望', html_url: 'u', number: 9 }] }), { status: 200 }),
      );
    }) as unknown as typeof fetch;
    const found = await findSimilarIssues('t', REPO, buildRequestIssue(draft(), '1.2.1'), gh);
    expect(found).toEqual([{ title: '同じ要望', url: 'u', number: 9 }]);
  });

  it('検索が落ちても提出は止めない(重複チェックは「できたら止める」もの)', async () => {
    const gh = (() => Promise.reject(new Error('rate limit'))) as unknown as typeof fetch;
    expect(await findSimilarIssues('t', REPO, buildRequestIssue(draft(), '1.2.1'), gh)).toEqual([]);
  });
});
