import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import type {
  AgentStatusView,
  ApprovalDecision,
  ApprovalRequestPayload,
  ChatMode,
  EvolutionEvent,
  EvolutionJobSummary,
  HistoryMessageView,
  PluginErrorInfo,
  RemoteSnapshot,
  ToolInfo,
} from '../../shared/types';
import type { AuditEntry } from '../audit';
import type { EventBus } from '../core/events';
import type { RemoteAuth } from './auth';

/**
 * M10-3: スマホWebアクセス用の内蔵HTTPサーバ。Node標準 `http` のみ(新規依存ゼロ)。
 * - REST + SSE(/api/events)+ remote-ui の静的配信
 * - 全 /api/* はトークン認証(Bearer ヘッダ。SSE は EventSource がヘッダ不可のためクエリも許可)
 * - ネットワーク境界は Tailscale 前提(README参照)。アプリ側はペアリングトークンを重ねる
 * - リモートに公開しない操作: secrets / settings変更 / workspace変更 / scopeMode変更
 */

/** AgentService を構造的に満たす、リモートへ公開してよい操作だけの窓口 */
export interface RemoteFacade {
  chatSend(text: string, mode: ChatMode): { sessionId: string };
  chatCancel(sessionId: string): void;
  approvalRespond(id: string, decision: ApprovalDecision): void;
  toolsList(): { tools: ToolInfo[]; errors: PluginErrorInfo[] };
  evolutionList(): EvolutionJobSummary[];
  evolutionEnqueue(description: string, expectedIO: string): Promise<{ jobId: number }>;
  evolutionPromoteRespond(jobId: number, approved: boolean): void;
  getStatus(): AgentStatusView;
  getHistoryView(): HistoryMessageView[];
  getPendingApprovals(): ApprovalRequestPayload[];
  getPendingPromotionRequests(): Extract<EvolutionEvent, { kind: 'promotion_request' }>[];
}

export interface RemoteServerDeps {
  facade: RemoteFacade;
  bus: EventBus;
  auth: RemoteAuth;
  /** remote-ui のビルド出力(out/remote-ui)。無ければ静的配信は404 */
  staticDir: string;
  auditTail: (limit: number) => AuditEntry[];
  /** SSE keep-alive 間隔 ms(テスト用に注入可) */
  heartbeatMs?: number;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const MAX_BODY_BYTES = 262_144;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBody(req)).toString('utf8');
  try {
    const parsed: unknown = raw.trim() === '' ? {} : JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'body がJSONオブジェクトとして不正');
  }
}

export class RemoteServer {
  private server: Server | null = null;
  private readonly sseCleanups = new Set<() => void>();

  constructor(private readonly deps: RemoteServerDeps) {}

  isRunning(): boolean {
    return this.server !== null;
  }

  /** listen 中の実ポート(テストで port 0 を使うため) */
  port(): number | null {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : null;
  }

  start(port: number, host = '0.0.0.0'): Promise<void> {
    if (this.server) return Promise.reject(new Error('リモートサーバは既に起動している'));
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500;
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) sendJson(res, status, { error: message });
        else res.end();
      });
    });
    this.server = server;
    return new Promise((resolvePromise, reject) => {
      server.once('error', (err) => {
        this.server = null;
        reject(err);
      });
      server.listen(port, host, () => resolvePromise());
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    if (!server) return Promise.resolve();
    this.server = null;
    // SSE接続は自然に閉じないため明示的に切る
    for (const cleanup of [...this.sseCleanups]) cleanup();
    return new Promise((resolvePromise) => {
      server.close(() => resolvePromise());
      // close は既存接続待ちになるため、残接続を強制切断する
      server.closeAllConnections();
    });
  }

  // ---- ルーティング ----

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    if (path === '/api/events') return this.handleSse(req, res, url);
    if (path.startsWith('/api/')) return this.handleApi(req, res, url);
    if (req.method === 'GET') return this.handleStatic(path, res);
    throw new HttpError(405, 'method not allowed');
  }

  private authorize(req: IncomingMessage, url: URL): void {
    const header = req.headers['authorization'];
    let token: string | undefined;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      token = header.slice('Bearer '.length).trim();
    }
    // EventSource はヘッダを付けられないため、クエリトークンも許可する
    token ??= url.searchParams.get('token') ?? undefined;
    const ip = req.socket.remoteAddress ?? 'unknown';
    const result = this.deps.auth.verify(token, ip);
    if (result === 'banned') throw new HttpError(429, '認証失敗が続いたため一時的にブロック中(60秒)');
    if (result !== 'ok') throw new HttpError(401, 'unauthorized');
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    this.authorize(req, url);
    const { facade } = this.deps;
    const route = `${req.method ?? 'GET'} ${url.pathname}`;

    switch (route) {
      case 'GET /api/status':
        return sendJson(res, 200, facade.getStatus());

      case 'GET /api/history':
        return sendJson(res, 200, { messages: facade.getHistoryView() });

      case 'GET /api/tools':
        return sendJson(res, 200, facade.toolsList());

      case 'GET /api/evolution':
        return sendJson(res, 200, { jobs: facade.evolutionList() });

      case 'GET /api/audit': {
        const rawLimit = Number(url.searchParams.get('limit') ?? '100');
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 1000) : 100;
        return sendJson(res, 200, { entries: this.deps.auditTail(limit) });
      }

      case 'POST /api/chat': {
        const body = await readJsonBody(req);
        const text = body['text'];
        if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'text が必要');
        const mode: ChatMode = body['mode'] === 'plan' ? 'plan' : 'normal';
        return sendJson(res, 200, facade.chatSend(text, mode));
      }

      case 'POST /api/chat/cancel': {
        const body = await readJsonBody(req);
        const sessionId = body['sessionId'];
        if (typeof sessionId !== 'string') throw new HttpError(400, 'sessionId が必要');
        facade.chatCancel(sessionId);
        return sendJson(res, 200, { ok: true });
      }

      case 'POST /api/approval/respond': {
        const body = await readJsonBody(req);
        const id = body['id'];
        const rawDecision = body['decision'];
        if (typeof id !== 'string') throw new HttpError(400, 'id が必要');
        if (rawDecision !== 'allow' && rawDecision !== 'allow-session' && rawDecision !== 'deny') {
          throw new HttpError(400, 'decision が不正');
        }
        // リモートからの allow-session は allow に降格する(セッション永続の許可は
        // 端末を目視しているデスクトップ操作に限る)
        const decision: ApprovalDecision = rawDecision === 'allow-session' ? 'allow' : rawDecision;
        facade.approvalRespond(id, decision);
        return sendJson(res, 200, { ok: true, applied: decision });
      }

      case 'POST /api/evolution/enqueue': {
        const body = await readJsonBody(req);
        const description = body['description'];
        const expectedIO = body['expectedIO'];
        if (typeof description !== 'string' || description.trim() === '') {
          throw new HttpError(400, 'description が必要');
        }
        if (typeof expectedIO !== 'string') throw new HttpError(400, 'expectedIO が必要');
        return sendJson(res, 200, await facade.evolutionEnqueue(description, expectedIO));
      }

      case 'POST /api/evolution/promote-respond': {
        const body = await readJsonBody(req);
        const jobId = body['jobId'];
        const approved = body['approved'];
        if (typeof jobId !== 'number' || typeof approved !== 'boolean') {
          throw new HttpError(400, 'jobId(number) と approved(boolean) が必要');
        }
        facade.evolutionPromoteRespond(jobId, approved);
        return sendJson(res, 200, { ok: true });
      }

      default:
        throw new HttpError(404, `unknown api: ${route}`);
    }
  }

  // ---- SSE ----

  private buildSnapshot(): RemoteSnapshot {
    const { facade } = this.deps;
    return {
      status: facade.getStatus(),
      history: facade.getHistoryView(),
      pendingApprovals: facade.getPendingApprovals(),
      pendingPromotions: facade.getPendingPromotionRequests(),
      jobs: facade.evolutionList(),
      tools: facade.toolsList().tools,
    };
  }

  private handleSse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    this.authorize(req, url);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    // 接続直後に現在状態を送る(再接続時の状態回復。Last-Event-ID は初版では未対応)
    write('snapshot', this.buildSnapshot());

    const unsubscribe = this.deps.bus.subscribeAll((channel, payload) => write(channel, payload));
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, this.deps.heartbeatMs ?? 25_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      this.sseCleanups.delete(cleanup);
      res.end();
    };
    this.sseCleanups.add(cleanup);
    req.on('close', cleanup);
  }

  // ---- 静的配信(パストラバーサル対策込み) ----

  private async handleStatic(rawPath: string, res: ServerResponse): Promise<void> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath);
    } catch {
      throw new HttpError(400, 'bad path');
    }
    if (decoded.includes('\0')) throw new HttpError(400, 'bad path');
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');

    const root = resolve(this.deps.staticDir);
    const target = resolve(root, relative);
    // 解決後のパスが root 配下でなければ拒否('../' や '..%2F'、バックスラッシュ迂回を含む)
    if (target !== root && !target.startsWith(root + sep)) throw new HttpError(404, 'not found');

    let data: Buffer;
    try {
      data = await readFile(target);
    } catch {
      throw new HttpError(404, 'not found');
    }
    const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
  }
}
