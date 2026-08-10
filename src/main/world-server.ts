/**
 * M173(C工事): 世界サーバ — 世界をアプリから切り出した独立プロセス。
 *
 * 目的: アプリ(AMA-teras)の再起動で世界とヒナタの連続性が壊れる問題の根治。
 * 世界の正本(state/チャット/アプリ)・SSE配信・実行係(専用Chromium)をこのプロセスが所有し、
 * アプリは1クライアント(テラの身体)になる。c案「ヒナタが世界を所有する」への第一歩。
 *
 * 起動: node out/main/world-server.cjs --port 8788 --state <world-state.json> --apps <world-apps>
 *        --static <out/remote-ui> --cdp 9226 [--app-job http://127.0.0.1:8787/api/world/job?k=...]
 * electronに依存しない(プレーンNode)。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFile } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EventBus } from './core/events';
import { WorldManager } from './world/manager';
import { WORLD_APP_HELPER } from './world/appHelper';
import type { WorldCommand, WorldPageEvent } from '../shared/types';

const argv = process.argv.slice(2);
const arg = (n: string, d?: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};

const PORT = Number(arg('port', '8788'));
const STATE_PATH = arg('state');
const APPS_DIR = arg('apps');
const STATIC_DIR = arg('static');
const CDP_PORT = Number(arg('cdp', '9226'));
const APP_JOB_URL = arg('app-job'); // ヒナタ→テラの発注中継先(アプリ)。未指定なら202で握る
const PROXY_KEY = arg('proxy-key'); // アプリ(テラの身体)用の合鍵。未指定ならアプリ接続不可
const NO_EXECUTOR = argv.includes('--no-executor');

if (STATE_PATH === undefined || STATIC_DIR === undefined) {
  console.error('usage: world-server --state <world-state.json> --static <out/remote-ui> [--apps <dir>] [--port N] [--cdp N]');
  process.exit(1);
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), '[world-server]', ...a);

// ---- 世界の正本 ----
const bus = new EventBus();
const world = new WorldManager(bus);
world.loadPersisted(STATE_PATH);
if (APPS_DIR !== undefined) world.setWorldAppsDir(APPS_DIR);
const executorKey = randomBytes(24).toString('hex');

// ---- HTTP ----
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.vrm': 'application/octet-stream', '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
};

function isLoopback(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(data);
}

function serveStatic(root: string, rel: string, res: ServerResponse, inject: boolean): void {
  const full = resolve(join(root, rel));
  if (!full.startsWith(resolve(root) + sep) && full !== resolve(root)) { res.writeHead(403); res.end(); return; }
  readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
    let out = data;
    if (inject && type.startsWith('text/html')) out = Buffer.concat([data, Buffer.from(WORLD_APP_HELPER, 'utf8')]);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(out);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { return {}; }
}

const server = createServer((req, res) => { void handle(req, res); });

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const key = url.searchParams.get('k');
  const keyed = isLoopback(req) && (key === executorKey || (PROXY_KEY !== undefined && key === PROXY_KEY));
  const proxied = isLoopback(req) && PROXY_KEY !== undefined && key === PROXY_KEY;
  try {
    // 静的: 世界ページ+資産(ループバック限定。公開面(A工事)は別途read-only surfaceで)
    if (req.method === 'GET' && (path === '/world.html' || path.startsWith('/assets') || path.startsWith('/motions') || path.startsWith('/avatars') || /\.(js|css|png|svg|vrm|glb|fbx|webmanifest|ico|mp3|wav)$/.test(path))) {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      serveStatic(STATIC_DIR!, path === '/' ? 'world.html' : path.slice(1), res, false);
      return;
    }
    if (req.method === 'GET' && path.startsWith('/world-apps/') && APPS_DIR !== undefined) {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      serveStatic(APPS_DIR, path.slice('/world-apps/'.length), res, true);
      return;
    }
    // ページ→正本
    if (req.method === 'POST' && path === '/api/world/event') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const body = (await readJsonBody(req)) as unknown as WorldPageEvent;
      sendJson(res, 200, world.onPageEvent(body));
      return;
    }
    // 観戦SSE(ループバック): 実行係の受信路+デーモンの知覚
    if (req.method === 'GET' && path === '/api/world/spectate') {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const restore = world.restorePayload();
      if (restore !== null) res.write(`event: world:event\ndata: ${JSON.stringify(restore)}\n\n`);
      const offEvent = bus.subscribe('world:event', (payload) => res.write(`event: world:event\ndata: ${JSON.stringify(payload)}\n\n`));
      const offChat = bus.subscribe('world:chat', (payload) => res.write(`event: world:chat\ndata: ${JSON.stringify(payload)}\n\n`));
      // M173: テラ宛て作業指示はアプリがブリッジで受ける
      const offAgent = bus.subscribe('world:agent-chat', (payload) => res.write(`event: world:agent-chat\ndata: ${JSON.stringify(payload)}\n\n`));
      const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 20_000);
      req.on('close', () => { clearInterval(ping); offEvent(); offChat(); offAgent(); });
      return;
    }
    // 生命体の身体(say/motion/move_to/face+アプリの手)
    if (req.method === 'POST' && path === '/api/world/command') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJsonBody(req);
      const cmds = body['cmds'];
      if (!Array.isArray(cmds) || cmds.length === 0 || cmds.length > 10) { sendJson(res, 400, { error: 'cmds(1〜10件)が必要' }); return; }
      const allowed = new Set(['say', 'motion', 'move_to', 'face', 'app_open', 'app_scan', 'app_click', 'app_type', 'app_read', 'app_leave']);
      const banned = (cmds as { type?: unknown }[]).find((c) => typeof c.type !== 'string' || !allowed.has(c.type));
      if (banned !== undefined) { sendJson(res, 400, { error: '許可外コマンド' }); return; }
      for (const c of cmds as WorldCommand[]) { if (c.type === 'say' && c.speaker === undefined) c.speaker = 'hinata'; }
      sendJson(res, 200, await world.act(cmds as WorldCommand[]));
      return;
    }
    if (req.method === 'GET' && path === '/api/world/state') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      sendJson(res, 200, world.observe());
      return;
    }
    if (req.method === 'GET' && path === '/api/world/chatlog') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      sendJson(res, 200, { log: world.chatHistory(200) });
      return;
    }
    // ヒナタ→テラの声の中継(アプリへ転送。アプリ不在でも世界は生きる=202で受ける)
    if (req.method === 'POST' && path === '/api/world/job') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJsonBody(req);
      if (APP_JOB_URL === undefined) { sendJson(res, 202, { ok: false, detail: 'アプリ未接続(声は世界に残るがテラには届かない)' }); return; }
      try {
        const r = await fetch(APP_JOB_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
        sendJson(res, r.status, await r.json().catch(() => ({})));
      } catch (e) {
        sendJson(res, 502, { ok: false, detail: String(e).slice(0, 100) });
      }
      return;
    }
    // アプリ(テラの身体)専用: フルコマンドのact(建築・カメラ・アプリ管理まで全部)
    if (req.method === 'POST' && path === '/api/world/act') {
      if (!proxied) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJsonBody(req);
      const cmds = body['cmds'];
      if (!Array.isArray(cmds) || cmds.length === 0 || cmds.length > 30) { sendJson(res, 400, { error: 'cmds(1〜30件)が必要' }); return; }
      sendJson(res, 200, await world.act(cmds as WorldCommand[]));
      return;
    }
    if (req.method === 'GET' && path === '/api/world/restore') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      sendJson(res, 200, { restore: world.restorePayload() });
      return;
    }
    if (req.method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true, connected: world.isConnected(), executor: executorProc !== null });
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    sendJson(res, 500, { error: String(e).slice(0, 200) });
  }
}

// ---- 実行係(専用Chromium): 世界の正実行体。アプリと運命を共にしない ----
let executorProc: ChildProcess | null = null;
function findChrome(): string | null {
  const cands = [
    process.env['AMATERAS_CHROME'] ?? '',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  for (const c of cands) if (c !== '' && existsSync(c)) return c;
  return null;
}
function launchExecutor(): void {
  if (NO_EXECUTOR) { log('実行係: 起動しない(--no-executor)'); return; }
  const chrome = findChrome();
  if (chrome === null) { log('実行係: Chromium未発見(AMATERAS_CHROMEで指定可)'); return; }
  const url = `http://127.0.0.1:${PORT}/world.html?executor=1&k=${executorKey}`;
  const profile = join(STATE_PATH!, '..', 'world-executor-profile');
  executorProc = spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--disable-extensions', '--mute-audio',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720',
    url,
  ], { stdio: 'ignore' });
  log(`実行係を起動: ${chrome.split(/[\\/]/).pop()} (CDP:${CDP_PORT})`);
  executorProc.on('exit', (code) => {
    log(`実行係が終了(code=${code})。10秒後に再起動`);
    executorProc = null;
    setTimeout(launchExecutor, 10_000);
  });
}

server.listen(PORT, '127.0.0.1', () => {
  log(`世界サーバ起動 http://127.0.0.1:${PORT} (state=${STATE_PATH})`);
  launchExecutor();
});

process.on('SIGTERM', () => { executorProc?.kill(); process.exit(0); });
process.on('SIGINT', () => { executorProc?.kill(); process.exit(0); });
