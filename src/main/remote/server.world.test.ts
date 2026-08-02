import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../audit';
import { EventBus } from '../core/events';
import { WorldManager } from '../world/manager';
import { generateToken, RemoteAuth } from './auth';
import { RemoteServer, type RemoteFacade } from './server';

/**
 * M115: 世界ブリッジのHTTP統合テスト。実物の RemoteServer + WorldManager で
 * 「ページ→POST /api/world/event→manager」「manager.act→SSE(world:event)→ack」の
 * 往復を検証する(world.html 実機QAはハーネスで別途実施)。
 */

const minimalFacade = (): RemoteFacade =>
  ({
    chatSend: () => ({ sessionId: 's' }),
    chatCancel: () => undefined,
    approvalRespond: () => undefined,
    toolsList: () => ({ tools: [], errors: [] }),
    evolutionList: () => [],
    evolutionEnqueue: async () => ({ jobId: 1 }),
    evolutionPromoteRespond: () => undefined,
    getStatus: () => ({ status: 'idle', activeSessionId: null, scopeMode: 'project', autonomous: false }),
    getHistoryView: () => [],
    getCurrentConversationId: () => 'c',
    runsList: () => [],
    getPendingApprovals: () => [],
    getPendingPromotionRequests: () => [],
    sessionsList: async () => [],
    sessionOpen: async () => ({ ok: true, history: [] }),
    sessionNew: () => ({ ok: true }),
    setAutonomous: (on: boolean) => ({ on }),
  }) as unknown as RemoteFacade;

function postJson(
  port: number,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * SSE を開く。接続確立(snapshot受信=購読開始済み)で onReady を呼び、
 * その後 world:event の data 1件を受け取ったら解決する
 */
function waitForWorldEvent(
  port: number,
  token: string,
  onReady: () => void,
): Promise<{ seq: number; cmds: unknown[] }> {
  return new Promise((resolve, reject) => {
    let ready = false;
    const req = httpRequest(
      { host: '127.0.0.1', port, path: `/api/events?token=${token}`, method: 'GET' },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          if (!ready && buf.includes('event: snapshot')) {
            ready = true;
            onReady();
          }
          const m = /event: world:event\ndata: (.+)\n/.exec(buf);
          if (m?.[1]) {
            req.destroy();
            resolve(JSON.parse(m[1]));
          }
        });
      },
    );
    req.on('error', () => reject(new Error('SSE接続に失敗')));
    req.end();
  });
}

let dir: string;
let bus: EventBus;
let server: RemoteServer;
let world: WorldManager;
let token: string;
let port: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-world-'));
  await mkdir(join(dir, 'remote-ui'), { recursive: true });
  await writeFile(join(dir, 'remote-ui', 'index.html'), '<html>ok</html>');
  bus = new EventBus();
  world = new WorldManager(bus, Date.now, 3000);
  const pair = generateToken();
  token = pair.token;
  const audit = new AuditLog(join(dir, 'audit.jsonl'));
  server = new RemoteServer({
    facade: minimalFacade(),
    bus,
    auth: new RemoteAuth({ getTokenHash: () => pair.tokenHash }),
    staticDir: join(dir, 'remote-ui'),
    auditTail: (limit) => audit.tail(limit),
    heartbeatMs: 60_000,
    world: { onPageEvent: (ev) => world.onPageEvent(ev) },
  });
  await server.start(0, '127.0.0.1');
  const p = server.port();
  if (p === null) throw new Error('port が取れない');
  port = p;
});

afterEach(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('RemoteServer × WorldManager 統合', () => {
  it('トークン無しの /api/world/event は 401', async () => {
    const r = await postJson(port, '/api/world/event', { kind: 'hello' });
    expect(r.status).toBe(401);
  });

  it('hello で接続扱いになり、チャットはハンドラへ届く', async () => {
    const seen: string[] = [];
    world.setChatHandler((t) => seen.push(t));
    const auth = { authorization: `Bearer ${token}` };
    expect(world.isConnected()).toBe(false);
    const r1 = await postJson(port, '/api/world/event', { kind: 'hello', state: { note: 'test' } }, auth);
    expect(r1.status).toBe(200);
    expect(world.isConnected()).toBe(true);
    const r2 = await postJson(port, '/api/world/event', { kind: 'chat', text: '世界からこんにちは' }, auth);
    expect(r2.status).toBe(200);
    expect(seen).toEqual(['世界からこんにちは']);
  });

  it('act のコマンドが SSE(world:event) で届き、ack で act が解決する', async () => {
    const auth = { authorization: `Bearer ${token}` };
    await postJson(port, '/api/world/event', { kind: 'hello' }, auth);
    let actPromise: Promise<{ ok: boolean; detail: string }> | null = null;
    const pushed = await waitForWorldEvent(port, token, () => {
      // SSE購読が確立してから押し出す(先に act すると誰にも届かないままタイムアウトする)
      actPromise = world.act([{ type: 'say', text: 'テストのセリフ' }]);
    });
    expect(pushed.cmds).toEqual([{ type: 'say', text: 'テストのセリフ' }]);
    // ページの実行完了(ack)を模擬 → act が解決する
    await postJson(
      port,
      '/api/world/event',
      { kind: 'ack', seq: pushed.seq, ok: true, state: { avatar: { x: 1, z: 0, motion: 'idle' } } },
      auth,
    );
    // コールバック内での代入はTSの制御フロー解析に見えないため、明示的に読み直す
    const started = actPromise as Promise<{ ok: boolean; detail: string }> | null;
    if (started === null) throw new Error('act が開始されていない');
    const result = await started;
    expect(result.ok).toBe(true);
    expect(world.observe().state?.avatar?.x).toBe(1);
  });
});
