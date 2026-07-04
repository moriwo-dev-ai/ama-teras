import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalDecision, ChatMode } from '../../shared/types';
import { AuditLog } from '../audit';
import { EventBus } from '../core/events';
import { generateToken, RemoteAuth } from './auth';
import { RemoteServer, type RemoteFacade } from './server';

interface FacadeCalls {
  chatSend: [string, ChatMode][];
  chatCancel: string[];
  approvalRespond: [string, ApprovalDecision][];
  promoteRespond: [number, boolean][];
  enqueue: [string, string][];
}

function stubFacade(): { facade: RemoteFacade; calls: FacadeCalls } {
  const calls: FacadeCalls = {
    chatSend: [],
    chatCancel: [],
    approvalRespond: [],
    promoteRespond: [],
    enqueue: [],
  };
  const facade: RemoteFacade = {
    chatSend: (text, mode) => {
      calls.chatSend.push([text, mode]);
      return { sessionId: 'sess-1' };
    },
    chatCancel: (sessionId) => {
      calls.chatCancel.push(sessionId);
    },
    approvalRespond: (id, decision) => {
      calls.approvalRespond.push([id, decision]);
    },
    toolsList: () => ({
      tools: [{ name: 'bash', description: 'd', risk: 'exec', warnings: [] }],
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
    getStatus: () => ({ status: 'idle', activeSessionId: null, scopeMode: 'project' }),
    getHistoryView: () => [{ role: 'user', text: 'こんにちは' }],
    getPendingApprovals: () => [],
    getPendingPromotionRequests: () => [],
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

async function startServer(opts?: { maxFailures?: number }): Promise<void> {
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
  });
  await server.start(0, '127.0.0.1');
  const p = server.port();
  if (p === null) throw new Error('port が取れない');
  port = p;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-remote-'));
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
    expect(JSON.parse(ok.body)).toEqual({ status: 'idle', activeSessionId: null, scopeMode: 'project' });
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
    expect(calls.chatSend).toEqual([['やって', 'plan']]);
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
