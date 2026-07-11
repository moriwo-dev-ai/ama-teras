import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalDecision, ChatImageInput, ChatMode } from '../../shared/types';
import { AuditLog } from '../audit';
import { EventBus } from '../core/events';
import { generateToken, RemoteAuth } from './auth';
import { RemoteServer, type RemoteFacade } from './server';

interface FacadeCalls {
  chatSend: [string, ChatMode, ChatImageInput[] | undefined][];
  chatCancel: string[];
  approvalRespond: [string, ApprovalDecision][];
  promoteRespond: [number, boolean][];
  enqueue: [string, string][];
  sessionOpen: string[];
  setAutonomous: boolean[];
}

function stubFacade(): { facade: RemoteFacade; calls: FacadeCalls } {
  const calls: FacadeCalls = {
    chatSend: [],
    chatCancel: [],
    approvalRespond: [],
    promoteRespond: [],
    enqueue: [],
    sessionOpen: [],
    setAutonomous: [],
  };
  const facade: RemoteFacade = {
    getCurrentConversationId: () => 'conv-1',
    sessionNew: () => ({ ok: true }),
    runsList: () => [],
    chatSend: (text, mode, images) => {
      calls.chatSend.push([text, mode, images]);
      return { sessionId: 'sess-1' };
    },
    chatCancel: (sessionId) => {
      calls.chatCancel.push(sessionId);
    },
    approvalRespond: (id, decision) => {
      calls.approvalRespond.push([id, decision]);
    },
    toolsList: () => ({
      tools: [{ name: 'bash', description: 'd', risk: 'exec', warnings: [], tags: [] }],
      errors: [],
    }),
    evolutionList: () => [
      { id: 1, description: 'demo', status: 'done', log: [], gates: [] },
    ],
    evolutionEnqueue: async (description, expectedIO) => {
      calls.enqueue.push([description, expectedIO]);
      return { jobId: 9 };
    },
    evolutionPromoteRespond: (jobId, approved) => {
      calls.promoteRespond.push([jobId, approved]);
    },
    getStatus: () => ({ status: 'idle', activeSessionId: null, scopeMode: 'project', autonomous: false }),
    getHistoryView: () => [{ role: 'user', text: 'こんにちは' }],
    getPendingApprovals: () => [],
    getPendingPromotionRequests: () => [],
    sessionsList: async () => [
      {
        id: '11111111-1111-1111-1111-111111111111',
        title: '過去の会話',
        workspace: 'C:\\ws',
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:01:00.000Z',
        messageCount: 2,
      },
    ],
    sessionOpen: async (id) => {
      calls.sessionOpen.push(id);
      return { ok: true, history: [{ role: 'user', text: '復元済み' }] };
    },
    setAutonomous: (on) => {
      calls.setAutonomous.push(on);
      return { on };
    },
  };
  return { facade, calls };
}

/** 生のリクエストパスを送る(fetch/URL による ../ 正規化を避けるため) */
function rawGet(
  port: number,
  rawPath: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: rawPath, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let dir: string;
let staticDir: string;
let bus: EventBus;
let server: RemoteServer;
let token: string;
let port: number;
let calls: FacadeCalls;

async function startServer(opts?: {
  maxFailures?: number;
  operations?: import('./server').RemoteOperationsFacade;
}): Promise<void> {
  const stub = stubFacade();
  calls = stub.calls;
  const pair = generateToken();
  token = pair.token;
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  audit.append({ tool: 'bash', scope: 'system', paths: ['C:/x'], event: 'approval', detail: 'allow' });
  audit.append({ tool: 'write_file', scope: 'system', paths: ['C:/y'], event: 'result', detail: 'ok' });
  server = new RemoteServer({
    facade: stub.facade,
    bus,
    auth: new RemoteAuth({
      getTokenHash: () => pair.tokenHash,
      maxFailures: opts?.maxFailures ?? 5,
    }),
    staticDir,
    auditTail: (limit) => audit.tail(limit),
    heartbeatMs: 60_000,
    ...(opts?.operations !== undefined ? { operations: opts.operations } : {}),
  });
  await server.start(0, '127.0.0.1');
  const p = server.port();
  if (p === null) throw new Error('port が取れない');
  port = p;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-remote-'));
  staticDir = join(dir, 'remote-ui');
  await mkdir(join(staticDir, 'assets'), { recursive: true });
  await writeFile(join(staticDir, 'index.html'), '<html>REMOTE_UI_OK</html>');
  await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  // 静的ルートの「外」に秘密ファイルを置く(トラバーサルで読めてはいけない)
  await writeFile(join(dir, 'secret.txt'), 'SECRET_DATA');
  bus = new EventBus();
});

afterEach(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const authed = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

describe('RemoteServer: 認証', () => {
  it('トークン無し/誤りの /api/* は 401、正しければ 200', async () => {
    await startServer();
    expect((await rawGet(port, '/api/status')).status).toBe(401);
    expect((await rawGet(port, '/api/status', { authorization: 'Bearer wrong' })).status).toBe(401);
    const ok = await rawGet(port, '/api/status', authed());
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ status: 'idle', activeSessionId: null, scopeMode: 'project', autonomous: false });
  });

  it('クエリトークンでも認証できる(SSE用)', async () => {
    await startServer();
    expect((await rawGet(port, `/api/status?token=${token}`)).status).toBe(200);
  });

  it('連続失敗でバンされ 429 になる', async () => {
    await startServer({ maxFailures: 2 });
    expect((await rawGet(port, '/api/status', { authorization: 'Bearer x' })).status).toBe(401);
    expect((await rawGet(port, '/api/status', { authorization: 'Bearer x' })).status).toBe(401);
    // バン発動後は正しいトークンでも 429
    expect((await rawGet(port, '/api/status', authed())).status).toBe(429);
  });

  it('静的配信(UI本体)は認証不要で取得できる', async () => {
    await startServer();
    const res = await rawGet(port, '/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('REMOTE_UI_OK');
  });
});

describe('RemoteServer: REST API', () => {
  it('POST /api/chat は facade.chatSend へ委譲し sessionId を返す', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'やって', mode: 'plan' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: 'sess-1' });
    expect(calls.chatSend).toEqual([['やって', 'plan', undefined]]);
  });

  it('M15.1: POST /api/chat は数MBの画像添付を受理して facade へ渡す(256KB上限の回帰防止)', async () => {
    await startServer();
    // base64で約2.7MB(=旧上限256KBを大きく超える)
    const bigImage = 'A'.repeat(2_700_000);
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '写真見て',
        images: [{ mediaType: 'image/jpeg', data: bigImage, description: 'photo' }],
      }),
    });
    expect(res.status).toBe(200);
    expect(calls.chatSend).toHaveLength(1);
    const [text, , images] = calls.chatSend[0]!;
    expect(text).toBe('写真見て');
    expect(images).toHaveLength(1);
    expect(images![0]!.data.length).toBe(2_700_000);
  });

  it('M15.1: 不正な画像payloadは 400、チャット上限(24MB)超は 413', async () => {
    await startServer();
    const bad = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x', images: [{ mediaType: 'text/plain', data: 'aGk=' }] }),
    });
    expect(bad.status).toBe(400);

    // 上限超過はサーバが受信を打ち切る(413応答 or 接続切断のどちらでも「拒否」)
    let rejected = false;
    try {
      const huge = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { ...authed(), 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'x',
          images: [{ mediaType: 'image/png', data: 'A'.repeat(25 * 1024 * 1024) }],
        }),
      });
      rejected = huge.status === 413;
    } catch {
      rejected = true; // 受信打ち切りによる接続リセット
    }
    expect(rejected).toBe(true);
    expect(calls.chatSend).toEqual([]);
  });

  it('M15.1: GET /api/sessions が一覧を返し、POST /api/sessions/load が facade.sessionOpen へ委譲する', async () => {
    await startServer();
    const list = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: authed() });
    expect(list.status).toBe(200);
    const parsed = (await list.json()) as { sessions: { title: string }[] };
    expect(parsed.sessions[0]!.title).toBe('過去の会話');

    const load = await fetch(`http://127.0.0.1:${port}/api/sessions/load`, {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({ id: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(load.status).toBe(200);
    expect(((await load.json()) as { ok: boolean }).ok).toBe(true);
    expect(calls.sessionOpen).toEqual(['11111111-1111-1111-1111-111111111111']);

    const noId = await fetch(`http://127.0.0.1:${port}/api/sessions/load`, {
      method: 'POST',
      headers: { ...authed(), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noId.status).toBe(400);
  });

  it('POST /api/chat の text 欠落は 400', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ mode: 'plan' }),
    });
    expect(res.status).toBe(400);
    expect(calls.chatSend).toEqual([]);
  });

  it('POST /api/approval/respond: allow-session は allow に降格される', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/approval/respond`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ id: 'ap-1', decision: 'allow-session' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, applied: 'allow' });
    expect(calls.approvalRespond).toEqual([['ap-1', 'allow']]);
  });

  it('M17-2: POST /api/autonomous は ON に confirmed:true を必須にする', async () => {
    await startServer();
    // 確認なしのONは 400 で拒否され、facade へ到達しない
    const noConfirm = await fetch(`http://127.0.0.1:${port}/api/autonomous`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ on: true }),
    });
    expect(noConfirm.status).toBe(400);
    expect(calls.setAutonomous).toEqual([]);

    // 確認ありのONは通る
    const on = await fetch(`http://127.0.0.1:${port}/api/autonomous`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ on: true, confirmed: true }),
    });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ on: true });

    // OFF は確認不要
    const off = await fetch(`http://127.0.0.1:${port}/api/autonomous`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ on: false }),
    });
    expect(off.status).toBe(200);
    expect(calls.setAutonomous).toEqual([true, false]);
  });

  it('進化API: 一覧 / enqueue / promote-respond', async () => {
    await startServer();
    const list = await fetch(`http://127.0.0.1:${port}/api/evolution`, { headers: authed() });
    expect(((await list.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);

    const enq = await fetch(`http://127.0.0.1:${port}/api/evolution/enqueue`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ description: 'PDF変換', expectedIO: 'in/out' }),
    });
    expect(await enq.json()).toEqual({ jobId: 9 });
    expect(calls.enqueue).toEqual([['PDF変換', 'in/out']]);

    const pr = await fetch(`http://127.0.0.1:${port}/api/evolution/promote-respond`, {
      method: 'POST',
      headers: authed(),
      body: JSON.stringify({ jobId: 9, approved: true }),
    });
    expect(pr.status).toBe(200);
    expect(calls.promoteRespond).toEqual([[9, true]]);
  });

  it('GET /api/audit は末尾エントリを新しい順で返し、limit が効く', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/audit?limit=1`, { headers: authed() });
    const body = (await res.json()) as { entries: { tool: string }[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]?.tool).toBe('write_file');
  });

  it('GET /api/history は表示用の履歴を返す', async () => {
    await startServer();
    const res = await fetch(`http://127.0.0.1:${port}/api/history`, { headers: authed() });
    expect(await res.json()).toEqual({ messages: [{ role: 'user', text: 'こんにちは' }] });
  });

  it('settings / secrets 系のAPIは存在しない(404)', async () => {
    await startServer();
    for (const p of ['/api/settings', '/api/secrets', '/api/workspace', '/api/scope-mode']) {
      const res = await rawGet(port, p, authed());
      expect(res.status, p).toBe(404);
    }
  });
});

describe('RemoteServer: 静的配信のパストラバーサル対策', () => {
  it.each([
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets/..%5c..%5csecret.txt',
  ])('%s で out/remote-ui の外は読めない', async (path) => {
    await startServer();
    const res = await rawGet(port, path);
    expect([400, 404]).toContain(res.status);
    expect(res.body).not.toContain('SECRET_DATA');
  });

  it('配下の正規ファイルは配信される(content-type付き)', async () => {
    await startServer();
    const res = await rawGet(port, '/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.body).toContain('console.log(1)');
  });
});

describe('RemoteServer: SSE', () => {
  it('接続直後に snapshot、その後バスのイベントが流れる', async () => {
    await startServer();
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=${token}`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('body が無い');
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (marker: string): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!buffer.includes(marker)) {
        if (Date.now() > deadline) throw new Error(`SSEで ${marker} が届かない: ${buffer}`);
        const { value, done } = await reader.read();
        if (done) throw new Error('SSEが切断された');
        buffer += decoder.decode(value, { stream: true });
      }
    };

    await readUntil('event: snapshot');
    expect(buffer).toContain('"scopeMode":"project"');
    expect(buffer).toContain('"pendingApprovals":[]');

    bus.publish('chat:event', { kind: 'text_delta', sessionId: 's', text: 'ハロー' });
    await readUntil('event: chat:event');
    expect(buffer).toContain('ハロー');

    bus.publish('approval:resolved', { id: 'ap', decision: 'deny' });
    await readUntil('event: approval:resolved');

    controller.abort();
    await server.stop();
  });

  it('SSE もトークン必須(無しは 401)', async () => {
    await startServer();
    const res = await rawGet(port, '/api/events');
    expect(res.status).toBe(401);
  });
});

describe('M34-6: 運営リモートAPI', () => {
  function rawPost(
    portNum: number,
    rawPath: string,
    body: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: portNum,
          path: rawPath,
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  const iwatoCalls: [string, boolean][] = [];
  const draftUpdates: [string, string][] = [];
  const clockUpdates: [string, string][] = [];
  const opsStub: import('./server').RemoteOperationsFacade = {
    summary: async () => ({
      enabled: true,
      clocks: [{ id: 'kamuhakari', godId: 'kamuhakari', intervalMin: 720, enabled: true, dailyTokenBudget: 60000, spentToday: 100 }],
      inbox: [],
      latest: null,
      pendingIwato: [{ id: 'iw-1', adapterId: 'github', action: 'comment', target: 'o/r#1', preview: '返信本文', compliance: 'c' }],
    }),
    threadList: () => [],
    threadSend: async (text) => [{ id: 'm1', ts: '', role: 'user', kind: 'text', body: text }],
    batches: () => [],
    batchRespond: async () => ({ ok: true, detail: '承認' }),
    iwatoRespond: (id, approved) => {
      iwatoCalls.push([id, approved]);
      return true;
    },
    // M40: スマホからのフル操作
    bulkRespond: async (_batchId, itemIds, approved) => ({
      ok: approved,
      detail: `${itemIds.length}件中${approved ? itemIds.length : 0}件成功`,
      results: itemIds.map((itemId) => ({ itemId, target: 't', ok: approved, detail: 'd' })),
      ...(approved ? { links: [{ itemId: itemIds[0] ?? '', label: 'X', url: 'https://x.com/intent/post?text=a' }] } : {}),
    }),
    drafts: async () => ({
      drafts: [
        { id: 'd1', kind: 'x-post', title: 't', body: 'b', createdAt: '', status: 'draft' },
      ],
      impacts: [],
      repos: ['o/r'],
    }),
    draftUpdate: (id, patch) => {
      draftUpdates.push([id, patch.status ?? '']);
      return null;
    },
    draftRelease: async (draftId, repo, tag) => ({ ok: true, detail: `${repo} ${tag} ${draftId}` }),
    draftZennArticle: async (draftId) => ({ ok: true, detail: `zenn ${draftId}` }),
    clockUpdate: (id, patch) => {
      clockUpdates.push([id, JSON.stringify(patch)]);
      return null;
    },
    godRun: async (godId) => ({ ok: true, detail: `ran ${godId}`, tokensUsed: 0 }),
  };

  it('operations 未注入なら /api/ops/* は404', async () => {
    await startServer();
    const res = await rawGet(port, '/api/ops/summary', authed());
    expect(res.status).toBe(404);
  });

  it('summary が時計と承認待ち岩戸(全文プレビュー込み)を返す・要トークン', async () => {
    await startServer({ operations: opsStub });
    expect((await rawGet(port, '/api/ops/summary')).status).toBe(401); // 認証なしは拒否
    const res = await rawGet(port, '/api/ops/summary', authed());
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { enabled: boolean; pendingIwato: { preview: string }[] };
    expect(body.enabled).toBe(true);
    expect(body.pendingIwato[0]?.preview).toBe('返信本文');
  });

  it('岩戸応答がルーティングされる(承認/拒否)+バリデーション', async () => {
    await startServer({ operations: opsStub });
    iwatoCalls.length = 0;
    const ok = await rawPost(port, '/api/ops/iwato-respond', { id: 'iw-1', approved: true }, authed());
    expect(ok.status).toBe(200);
    expect(iwatoCalls).toEqual([['iw-1', true]]);
    const bad = await rawPost(port, '/api/ops/iwato-respond', { id: 42 }, authed());
    expect(bad.status).toBe(400);
  });

  it('⛩スレッド送信がルーティングされる', async () => {
    await startServer({ operations: opsStub });
    const res = await rawPost(port, '/api/ops/thread', { text: 'キーワード変えて' }, authed());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).messages[0].body).toBe('キーワード変えて');
  });

  // ---- M40: スマホからのフル操作(デスクトップ同等) ----

  it('M40: 一括承認がルーティングされ、リンク媒体のURLが返る(スマホが開く)', async () => {
    await startServer({ operations: opsStub });
    expect((await rawPost(port, '/api/ops/bulk-respond', { batchId: 'b1', itemIds: ['i1'], approved: true })).status).toBe(401);
    const res = await rawPost(port, '/api/ops/bulk-respond', { batchId: 'b1', itemIds: ['i1', 'i2'], approved: true }, authed());
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { detail: string; links?: { url: string }[] };
    expect(body.detail).toBe('2件中2件成功');
    expect(body.links?.[0]?.url).toContain('x.com/intent');
    // バリデーション: itemIds は string[]
    expect((await rawPost(port, '/api/ops/bulk-respond', { batchId: 'b1', itemIds: 'i1', approved: true }, authed())).status).toBe(400);
  });

  it('M40: 発信ドラフトの取得と操作(投稿済み・Release・Zenn記事化)', async () => {
    await startServer({ operations: opsStub });
    const list = await rawGet(port, '/api/ops/drafts', authed());
    expect(JSON.parse(list.body).drafts[0].id).toBe('d1');
    expect(JSON.parse(list.body).repos).toEqual(['o/r']);

    await rawPost(port, '/api/ops/draft-update', { id: 'd1', patch: { status: 'posted' } }, authed());
    expect(draftUpdates).toContainEqual(['d1', 'posted']);

    const rel = await rawPost(port, '/api/ops/draft-release', { draftId: 'd1', repo: 'o/r', tag: 'v1.0.1' }, authed());
    expect(JSON.parse(rel.body).detail).toBe('o/r v1.0.1 d1');

    const zenn = await rawPost(port, '/api/ops/draft-zenn', { draftId: 'd1' }, authed());
    expect(JSON.parse(zenn.body).detail).toBe('zenn d1');

    // バリデーション
    expect((await rawPost(port, '/api/ops/draft-release', { draftId: 'd1', repo: 'o/r' }, authed())).status).toBe(400);
  });

  it('M40: 時計の操作(稼働・予算・🔓解錠)と神の手動実行', async () => {
    await startServer({ operations: opsStub });
    await rawPost(port, '/api/ops/clock-update', { id: 'omoi-kami', patch: { enabled: true, dailyTokenBudget: 20000 } }, authed());
    await rawPost(port, '/api/ops/clock-update', { id: 'omoi-kami', patch: { budgetSetByUser: false } }, authed());
    expect(clockUpdates[0]?.[1]).toContain('20000');
    expect(clockUpdates[1]?.[1]).toContain('"budgetSetByUser":false');
    // 施錠(true)はリモートからは立てられない(予算設定時に自動で立つ経路のみ)
    await rawPost(port, '/api/ops/clock-update', { id: 'omoi-kami', patch: { budgetSetByUser: true } }, authed());
    expect(clockUpdates[2]?.[1]).not.toContain('budgetSetByUser');

    const run = await rawPost(port, '/api/ops/god-run', { godId: 'omoi-kami' }, authed());
    expect(JSON.parse(run.body).detail).toBe('ran omoi-kami');
    expect((await rawPost(port, '/api/ops/god-run', {}, authed())).status).toBe(400);
  });
});

describe('RemoteServer: ライフサイクル', () => {
  it('stop 後は接続できない', async () => {
    await startServer();
    await server.stop();
    await expect(rawGet(port, '/api/status', authed())).rejects.toThrow();
  });

  it('二重 start はエラー', async () => {
    await startServer();
    await expect(server.start(0, '127.0.0.1')).rejects.toThrow();
  });
});
