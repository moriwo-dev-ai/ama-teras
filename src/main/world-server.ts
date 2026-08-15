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
import { existsSync, mkdirSync, readdirSync, readFile, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
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
const VISITORS_PATH = arg('visitors'); // M175: 招待名簿 [{name,key}]。未指定なら訪問機能なし
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
// 実行キーは再起動をまたいで固定(実測: サーバ再起動のたびデーモンの合鍵が失効し彼女の行動が全部401になった)。
// ループバック限定なので固定化のリスクは増えない
const keyPath = join(STATE_PATH, '..', 'world-server-executor.key');
let executorKey: string;
try {
  executorKey = readFileSync(keyPath, 'utf8').trim();
  if (!/^[0-9a-f]{16,}$/.test(executorKey)) throw new Error('bad');
} catch {
  executorKey = randomBytes(24).toString('hex');
  try { writeFileSync(keyPath, executorKey); } catch { /* 書けなくても稼働は続ける */ }
}

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
  // URLの%20等をファイル名へ戻す(スペース入りFBXが全404になっていた)。デコード後に脱出判定
  try { rel = decodeURIComponent(rel); } catch { res.writeHead(400); res.end(); return; }
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
    if (req.method === 'GET' && path.startsWith('/tts/')) {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      serveStatic(TTS_DIR, path.slice('/tts/'.length), res, false);
      return;
    }
    if (req.method === 'GET' && (path === '/world.html' || path.startsWith('/assets') || path.startsWith('/motions') || path.startsWith('/avatars') || /\.(js|css|png|svg|vrm|glb|fbx|webmanifest|ico|mp3|wav)$/.test(path))) {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      serveStatic(STATIC_DIR!, path === '/' ? 'world.html' : path.slice(1), res, false);
      return;
    }
    if (req.method === 'GET' && path.startsWith('/world-apps/') && APPS_DIR !== undefined) {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      // ディレクトリURL(/world-apps/moon/)はindex.htmlへ解決(実測: 未解決だと404が
      // iframeに載り、ヘルパー不在で全アプリ操作が「応答しない」になった)
      let rel = path.slice('/world-apps/'.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      else if (!rel.split('/').pop()!.includes('.')) rel += '/index.html';
      serveStatic(APPS_DIR, rel, res, true);
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
    // 生命体の身体(say/motion/move_to/face+アプリの手)。M200: affect(表情)+声の合成
    if (req.method === 'POST' && path === '/api/world/command') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJsonBody(req);
      const cmds = body['cmds'];
      if (!Array.isArray(cmds) || cmds.length === 0 || cmds.length > 10) { sendJson(res, 400, { error: 'cmds(1〜10件)が必要' }); return; }
      const allowed = new Set(['say', 'motion', 'move_to', 'face', 'app_open', 'app_scan', 'app_click', 'app_type', 'app_read', 'app_leave', 'affect', 'affect_burst']);
      const banned = (cmds as { type?: unknown }[]).find((c) => typeof c.type !== 'string' || !allowed.has(c.type));
      if (banned !== undefined) { sendJson(res, 400, { error: '許可外コマンド' }); return; }
      for (const c of cmds as WorldCommand[]) {
        if (c.type === 'affect' && c.affect !== undefined) lastAffect = sanitizeAffect(c.affect);
        if (c.type === 'say' && c.speaker === undefined) c.speaker = 'hinata';
        if (c.type === 'say' && c.speaker === 'hinata' && typeof c.text === 'string') {
          await hinataVoice(c).catch((e) => log('声の合成失敗(声なしで続行):', String(e).slice(0, 80)));
        }
      }
      sendJson(res, 200, await world.act(cmds as WorldCommand[]));
      return;
    }
    if (req.method === 'GET' && path === '/api/world/state') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      // M175: 公開面の観戦者数を気配として添える(ヒナタのwatchers知覚)
      // M176: 訪問者の名前と位置=「だれが・どこにいるか」をヒナタが知覚できる
      sendJson(res, 200, {
        ...world.observe(),
        watchers: publicSseCount,
        // M198: id接頭辞sp_=立ち見客。mark/colorName=個体の見た目(ヒナタには見た目値として渡る)
        visitors: allGhosts().map((g) => ({ id: g.id, name: g.name, x: g.x, z: g.z, stance: g.stance, mark: g.mark, colorName: g.colorName })),
      });
      return;
    }
    // M201: 世界の復元スナップショット(アプリのクライアントが常時キャッシュし、
    // アプリ経由で開いた全ページへ即返せるようにする=単独で開いても世界が空にならない)
    if (req.method === 'GET' && path === '/api/world/restore') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      sendJson(res, 200, { restore: world.restorePayload() });
      return;
    }
    if (req.method === 'GET' && path === '/api/world/chatlog') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      sendJson(res, 200, { log: world.chatHistory(200) });
      return;
    }
    // M199: 実行係の録画保存口(成長実録のリングバッファ)。webmをそのまま受けて時刻名で保存
    if (req.method === 'POST' && path === '/api/world/recording') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const dir = VISITORS_PATH !== undefined ? join(VISITORS_PATH, '..', 'recordings') : join(process.cwd(), 'recordings');
      try { mkdirSync(dir, { recursive: true }); } catch { /* 既存 */ }
      const file = join(dir, `rec-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 500 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(c as Buffer);
      }
      writeFileSync(file, Buffer.concat(chunks));
      log(`録画保存: ${file} (${Math.round(size / 1024 / 1024)}MB)`);
      sendJson(res, 200, { ok: true, file });
      return;
    }
    // M212: 司書の脳の中継(図書館/テレビの要約→アプリがKimi K3で代行)。アプリ不在は202
    if (req.method === 'POST' && path === '/api/world/summarize') {
      if (!keyed) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJsonBody(req);
      if (APP_JOB_URL === undefined) { sendJson(res, 202, { ok: false, detail: 'アプリ未接続' }); return; }
      try {
        const u = APP_JOB_URL.replace('/api/world/job', '/api/world/summarize');
        const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40_000) });
        sendJson(res, r.status, await r.json().catch(() => ({})));
      } catch { sendJson(res, 502, { ok: false }); }
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
    // M177(配信工事): アプリからの配信転送 — コメント/HUDの表示・配信ガード・@ヒナタの声
    if (req.method === 'POST' && path === '/api/world/live') {
      if (!proxied) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      const body = await readJsonBody(req);
      const kind = String(body['kind'] ?? '');
      if (kind === 'cmds' && Array.isArray(body['cmds'])) {
        world.publishQuiet(body['cmds'] as WorldCommand[]);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (kind === 'guard') {
        world.setLiveGuard(body['on'] === true);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (kind === 'hinata-chat' && typeof body['who'] === 'string' && typeof body['text'] === 'string') {
        // 視聴者の「@ヒナタ」— 表示(弾幕)はアプリ側が済ませているので、知覚だけ届ける
        world.hinataHear(String(body['who']).slice(0, 20), String(body['text']).slice(0, 120));
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 400, { error: 'kindが不正' });
      return;
    }
    // M176: 訪問者口はメイン側(合鍵)でも使える — アプリ経由のオーナー歩行(walk)用
    if (req.method === 'POST' && path === '/api/world/visitor') {
      const body = await readJsonBody(req);
      const kind = String(body['kind'] ?? 'chat');
      const { code, res: r } = kind === 'pos' ? handleVisitorPos(body) : handleVisitorChat(body);
      sendJson(res, code, r);
      return;
    }
    // M196: ローカル観戦(開発機ビューア)も立ち見客になれる
    if (req.method === 'POST' && path === '/api/world/spectator') {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      const body = await readJsonBody(req);
      const { code, res: r } = handleSpectatorBeat(body);
      sendJson(res, code, r);
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

// 実行係の健全性見張り: プロセスは生きているのにレンダラだけ死ぬ事故(実測 2026-08-11 01:19)への対策。
// 世界からの報告が2分途絶えたら実行係を作り直す(exitハンドラが10秒後に自動再起動する)
setInterval(() => {
  if (NO_EXECUTOR || executorProc === null) return;
  if (!world.isConnected()) {
    log('実行係が沈黙(2分)。レンダラ死亡とみなして作り直す');
    try { executorProc.kill(); } catch { /* もう死んでいる */ }
  }
}, 120_000);

// ---- M175(B工事): 訪問者(招待制) ----
// 名簿はJSONファイル(userData/world-visitors.json)。鍵→名前。発言は1人5秒に1回・120字・NG語遮断。
// 訪問者はヒナタの友達=テラへの発注経路なし・建築なし・声だけ(弾幕表示+ヒナタが知覚)
type Visitor = { name: string; key: string };
function loadVisitors(): Visitor[] {
  if (VISITORS_PATH === undefined) return [];
  try {
    const raw = JSON.parse(readFileSync(VISITORS_PATH, 'utf8')) as unknown;
    return Array.isArray(raw) ? (raw as Visitor[]).filter((v) => typeof v.name === 'string' && typeof v.key === 'string') : [];
  } catch { return []; }
}
const visitorLastAt = new Map<string, number>();
let publicSseCount = 0; // M175: 公開面の観戦者数=ヒナタの「気配」になる

// M176(B v2): 訪問者のアバター(ゴースト)。位置を持つ=ヒナタが「どこにいるか」を知覚できる
type VisitorState = { name: string; x: number; z: number; stance: string; lastAt: number };
const visitorStates = new Map<string, VisitorState>(); // key=招待キー
const vidOf = (key: string) => key.slice(0, 8); // 表示用ID(招待キーは晒さない)

// M198: 個体の見た目(世界の解像度)。胸の紋=個体キー先頭4桁・色相=紋の前半から導出
// =紋と色は本当に相関している(ヒナタがその法則を自分で見つけられる)。名前と独立・再来訪でも同じ
const TRAD_COLORS: { name: string; h: number }[] = [
  { name: 'くれない', h: 0 }, { name: 'やまぶき', h: 40 }, { name: 'たまご', h: 55 },
  { name: 'わかくさ', h: 90 }, { name: 'ときわ', h: 140 }, { name: 'あさぎ', h: 175 },
  { name: 'あいいろ', h: 210 }, { name: 'るり', h: 235 }, { name: 'ふじ', h: 265 },
  { name: 'あやめ', h: 290 }, { name: 'つつじ', h: 320 }, { name: 'さくら', h: 345 },
];
function traitsOf(seed: string): { mark: string; hue: number; colorName: string } {
  const mark = seed.slice(0, 4).toUpperCase();
  const hue = Math.round((parseInt(seed.slice(0, 2), 16) / 256) * 360) % 360;
  let best = TRAD_COLORS[0] as { name: string; h: number };
  let bd = 999;
  for (const c of TRAD_COLORS) {
    const d = Math.min(Math.abs(c.h - hue), 360 - Math.abs(c.h - hue));
    if (d < bd) { bd = d; best = c; }
  }
  return { mark, hue, colorName: best.name };
}
function handleVisitorPos(body: Record<string, unknown>): { code: number; res: unknown } {
  const vk = String(body['vk'] ?? '');
  const sp = speakerOf(vk); // M206: 招待客もゲストも歩ける
  if (sp === undefined) return { code: 401, res: { error: '招待キーが違う' } };
  if (sp.sid !== undefined && bannedSids().includes(sp.sid)) return { code: 403, res: { error: 'この世界には入れません' } };
  const x = Number(body['x']), z = Number(body['z']);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return { code: 400, res: { error: '座標が不正' } };
  const cx = Math.max(-18, Math.min(18, x)), cz = Math.max(-18, Math.min(18, z));
  const prev = visitorStates.get(vk);
  const isNew = prev === undefined;
  const stance = ['stand','sit','crouch'].includes(String(body['stance'])) ? String(body['stance']) : 'stand';
  visitorStates.set(vk, { name: sp.name.slice(0, 12), x: cx, z: cz, stance, lastAt: Date.now() });
  world.visitorSync(vidOf(vk), sp.name.slice(0, 12), cx, cz, stance, traitsOf(sp.traitSeed));
  if (isNew) log(`訪問者が入場: ${sp.name}${sp.kind === 'guest' ? '(ゲスト)' : ''} (${cx.toFixed(1)}, ${cz.toFixed(1)})`);
  return { code: 200, res: { ok: true, id: vidOf(vk) } }; // M189: 自分のゴーストID(一人称視点で自分を消すため)
}
// 30秒音沙汰なし=退場(ゴーストを消し、ヒナタの知覚からも消える)
setInterval(() => {
  const now = Date.now();
  for (const [vk, s] of visitorStates) {
    if (now - s.lastAt > 30_000) {
      visitorStates.delete(vk);
      world.visitorGone(vidOf(vk), s.name);
      log(`訪問者が退場: ${s.name}`);
    }
  }
}, 10_000);
// M196: 観戦者も「立ち見客」としてY Botで立つ(声なし・広場の縁の定位置・上限10)。
// 招待キー不要=ページが自分で発行したsidだけ。声とアバター操作は引き続き招待制のまま
type SpectatorState = { id: string; name: string; slot: number; x: number; z: number; lastAt: number };
const spectators = new Map<string, SpectatorState>();
const SPEC_MAX = 10;
// M197: 個体識別 — 名前は被ってよい。sid(端末永続)が個体で、台帳に来訪履歴を刻む。
// 「誰が・何度・どの名前で来たか」= 成長観測のオーナー側データ(ヒナタには渡さない生情報)
type SpecRecord = { lastName: string; names: string[]; firstAt: string; lastAt: string; visits: number };
const SPEC_LOG_PATH = VISITORS_PATH !== undefined
  ? join(VISITORS_PATH, '..', 'world-spectator-log.json')
  : join(process.cwd(), 'world-spectator-log.json');
let specLog: Record<string, SpecRecord> = {};
try { specLog = JSON.parse(readFileSync(SPEC_LOG_PATH, 'utf8')) as Record<string, SpecRecord>; } catch { /* 初回 */ }
let specLogSavedAt = 0;
function recordSpectator(sid: string, name: string, isNewSession: boolean): void {
  const now = new Date().toISOString();
  const r = specLog[sid] ?? { lastName: name, names: [], firstAt: now, lastAt: now, visits: 0 };
  const nameIsNew = name !== '' && !r.names.includes(name);
  if (nameIsNew) { r.names.push(name); if (r.names.length > 10) r.names.shift(); }
  if (name !== '') r.lastName = name;
  r.lastAt = now;
  if (isNewSession) r.visits++;
  specLog[sid] = r;
  // 心拍のたびに書かない(入場・改名・5分毎だけ)
  if (isNewSession || nameIsNew || Date.now() - specLogSavedAt > 300_000) {
    specLogSavedAt = Date.now();
    try { writeFileSync(SPEC_LOG_PATH, JSON.stringify(specLog, null, 1)); } catch { /* noop */ }
  }
}
function handleSpectatorBeat(body: Record<string, unknown>): { code: number; res: unknown } {
  const sid = String(body['sid'] ?? '');
  if (!/^[0-9a-f]{8,32}$/.test(sid)) return { code: 400, res: { error: 'sidが不正' } };
  // M196c: 観戦もユーザーネーム必須(名札とヒナタの知覚に乗る)。NG語・長さはここで守る
  const name = String(body['name'] ?? '').trim().slice(0, 12);
  // M202: 名前を入れずに見ているだけの人も「来た人」として数える(世界には現れない)。
  // 動画やSNSから何人が実際に覗きに来たかは、名乗った人だけでは分からない
  if (name === '' && body['anon'] === true) {
    recordSpectator(sid, '', !spectators.has(sid) && specLog[sid] === undefined);
    return { code: 200, res: { ok: true, anon: true } };
  }
  if (name === '') return { code: 400, res: { error: '名前が必要' } };
  if (NG_WORDS.test(name)) return { code: 400, res: { error: 'その名前は世界に持ち込めない' } };
  let s = spectators.get(sid);
  if (s === undefined) {
    if (spectators.size >= SPEC_MAX) return { code: 200, res: { ok: false, full: true } };
    const used = new Set([...spectators.values()].map((v) => v.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    const ang = (slot / SPEC_MAX) * Math.PI * 2 + Math.PI / SPEC_MAX;
    const x = +(13.5 * Math.cos(ang)).toFixed(1), z = +(13.5 * Math.sin(ang)).toFixed(1);
    // M197: ゴーストIDは席番号ではなくsid由来=同名でも個体が区別でき、再来訪でも同じIDになる
    s = { id: `sp_${sid.slice(0, 8)}`, name, slot, x, z, lastAt: Date.now() };
    spectators.set(sid, s);
    recordSpectator(sid, name, true);
    const rec = specLog[sid];
    log(`立ち見客が入場: ${s.name} [${sid.slice(0, 8)}] ${rec !== undefined ? `${rec.visits}回目` : ''}`);
    world.visitorSync(s.id, s.name, s.x, s.z, 'stand', traitsOf(sid));
  } else if (s.name !== name) {
    log(`立ち見客が改名: ${s.name} → ${name} [${sid.slice(0, 8)}]`);
    s.name = name;
    recordSpectator(sid, name, false);
    world.visitorSync(s.id, s.name, s.x, s.z, 'stand', traitsOf(sid));
  } else {
    recordSpectator(sid, name, false);
  }
  s.lastAt = Date.now();
  return { code: 200, res: { ok: true, id: s.id, name: s.name } };
}
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of spectators) {
    if (now - s.lastAt > 40_000) {
      spectators.delete(sid);
      world.visitorGone(s.id, s.name);
      log(`立ち見客が退場: ${s.name}`);
    }
  }
}, 10_000);
/** 訪問者+立ち見客(ヒナタの知覚・poll・観戦ページの全員に見える)。M198: 個体の見た目つき */
function allGhosts(): { id: string; name: string; x: number; z: number; stance: string; mark: string; hue: number; colorName: string }[] {
  return [
    // M206: ゲストの紋はsid由来=観戦時代と同一個体に見える(speakerOfが引けない瞬間はキーで代用)
    ...[...visitorStates.entries()].map(([k, s]) => ({ id: vidOf(k), name: s.name, x: s.x, z: s.z, stance: s.stance, ...traitsOf(speakerOf(k)?.traitSeed ?? k) })),
    ...[...spectators.entries()].map(([sid, s]) => ({ id: s.id, name: s.name, x: s.x, z: s.z, stance: 'stand', ...traitsOf(sid) })),
  ];
}

// ---- M200: ヒナタの声(VOICEVOX 猫使ビィ)と表情の無意識層 ----
// クレジット表記「VOICEVOX:猫使ビィ」は配信概要欄・動画説明に必要
const VV = 'http://127.0.0.1:50021';
const BII = { normal: 58, calm: 59, shy: 60 }; // ノーマル/おちつき/人見知り
const TTS_DIR = VISITORS_PATH !== undefined ? join(VISITORS_PATH, '..', 'tts-cache') : join(process.cwd(), 'tts-cache');
try { mkdirSync(TTS_DIR, { recursive: true }); } catch { /* 既存 */ }
type Affect = { joy: number; fear: number; sleepy: number; arousal: number };
let lastAffect: Affect = { joy: 0, fear: 0, sleepy: 0, arousal: 0 };
const cl01 = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; };
function sanitizeAffect(a: Record<string, unknown>): Affect {
  return { joy: cl01(a['joy']), fear: cl01(a['fear']), sleepy: cl01(a['sleepy']), arousal: cl01(a['arousal']) };
}
type VvMora = { text: string; vowel: string; consonant_length?: number | null; vowel_length: number; pitch: number };
type VvQuery = {
  accent_phrases: { moras: VvMora[]; pause_mora?: VvMora | null }[];
  speedScale: number; pitchScale: number; intonationScale: number; prePhonemeLength: number; postPhonemeLength: number;
};
async function vvQuery(text: string, speaker: number): Promise<VvQuery> {
  const r = await fetch(`${VV}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, { method: 'POST', signal: AbortSignal.timeout(8_000) });
  if (!r.ok) throw new Error(`audio_query ${r.status}`);
  return (await r.json()) as VvQuery;
}
/** 声の合成: L0=内部状態がベースの声色(スタイル+韻律)・L1=強調語のピッチ上昇。
 *  口パク時系列(モーラ→母音)と強調タイミングをsayコマンドに同梱=顔と声がミリ秒同期する */
async function hinataVoice(c: WorldCommand): Promise<void> {
  const text = String(c.text ?? '').trim();
  if (text === '' || text.length > 200) return;
  const a = lastAffect;
  const style = a.fear > 0.45 ? BII.shy : a.sleepy > 0.55 ? BII.calm : BII.normal;
  const q = await vvQuery(text, style);
  q.pitchScale = Math.max(-0.06, Math.min(0.1, a.joy * 0.05 - a.sleepy * 0.03));
  q.intonationScale = Math.max(0.7, Math.min(1.6, 1 + a.joy * 0.35 + a.arousal * 0.1 - a.sleepy * 0.3));
  q.speedScale = Math.max(0.82, Math.min(1.18, 1 + a.arousal * 0.07 - a.sleepy * 0.13));
  // L1: 強調語のモーラを特定してピッチを持ち上げる(語の読みは単体queryで得る)
  let emphRange: [number, number] | null = null;
  if (typeof c.emph === 'string' && c.emph.trim() !== '' && text.includes(c.emph.trim())) {
    try {
      const wq = await vvQuery(c.emph.trim(), style);
      const wKana = wq.accent_phrases.flatMap((p) => p.moras.map((m) => m.text)).join('');
      const all = q.accent_phrases.flatMap((p) => p.moras);
      const seq = all.map((m) => m.text).join('');
      const at = seq.indexOf(wKana);
      if (at >= 0 && wKana.length > 0) {
        // 何モーラ目から始まるか(結合文字列の位置→モーラ位置へ変換)
        let pos = 0, startIdx = -1, endIdx = -1;
        for (let i = 0; i < all.length; i++) {
          if (pos === at && startIdx === -1) startIdx = i;
          pos += (all[i] as VvMora).text.length;
          if (pos === at + wKana.length && startIdx !== -1) { endIdx = i; break; }
        }
        if (startIdx >= 0 && endIdx >= startIdx) {
          for (let i = startIdx; i <= endIdx; i++) (all[i] as VvMora).pitch = Math.min(6.5, (all[i] as VvMora).pitch + 0.32);
          emphRange = [startIdx, endIdx];
        }
      }
    } catch { /* 強調なしで続行 */ }
  }
  // 口パク時系列+強調タイミング(モーラ長を積算)
  const mouth: [number, string, number][] = [];
  let t = q.prePhonemeLength / q.speedScale;
  let idx = 0;
  for (const p of q.accent_phrases) {
    for (const m of p.moras) {
      const dur = (((m.consonant_length ?? 0) + m.vowel_length)) / q.speedScale;
      mouth.push([+t.toFixed(3), m.vowel, +dur.toFixed(3)]);
      if (emphRange !== null && idx === emphRange[0]) { c.emphAt = +t.toFixed(3); }
      if (emphRange !== null && idx === emphRange[1]) { c.emphDur = +(t + dur - (c.emphAt ?? 0)).toFixed(3); }
      t += dur;
      idx++;
    }
    if (p.pause_mora != null) t += p.pause_mora.vowel_length / q.speedScale;
  }
  const sr = await fetch(`${VV}/synthesis?speaker=${style}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(q), signal: AbortSignal.timeout(15_000),
  });
  if (!sr.ok) throw new Error(`synthesis ${sr.status}`);
  const wav = Buffer.from(await sr.arrayBuffer());
  const file = `v-${Date.now()}-${randomBytes(3).toString('hex')}.wav`;
  writeFileSync(join(TTS_DIR, file), wav);
  c.audio = `/tts/${file}`;
  c.mouth = mouth;
  // 掃除: 200本を超えたら古い順に消す
  try {
    const files = readdirSync(TTS_DIR).filter((f) => f.startsWith('v-')).sort();
    while (files.length > 200) { const f = files.shift(); if (f !== undefined) unlinkSync(join(TTS_DIR, f)); }
  } catch { /* noop */ }
}

const NG_WORDS = /(死ね|殺す|きもい|うざい|ばか|バカ|アホ|http|www\.|\.com|\.jp)/i;

// ---- M206: 一般公開ゲスト(観戦→歩ける昇格) ----
// 鍵はsidから決定的に導出(=再訪で同じ個体・同じ紋と色)。名簿ファイルは分析用の記録。
// 荒らし対策: 出禁リスト(sid)・予約名・50字・10秒に1回・1日200件・近接会話ゲート(5m)・同時5人
type Guest = { sid: string; name: string; key: string; firstAt: string; lastAt: string };
const GUESTS_PATH = VISITORS_PATH !== undefined ? join(VISITORS_PATH, '..', 'world-guests.json') : undefined;
const BAN_PATH = VISITORS_PATH !== undefined ? join(VISITORS_PATH, '..', 'world-banned.json') : undefined;
const RESERVED_NAME = /^(ヒナタ|ひなた|日向|テラ|てら|もりを|もりお|森川|運営|admin|owner)$/i;
const GUEST_MAX_ACTIVE = 5;      // 同時歩行の上限
const GUEST_TEXT_MAX = 50;       // 発言の文字数上限
const GUEST_RATE_MS = 10_000;    // 発言間隔
const GUEST_DAILY_MAX = 200;     // 1個体1日の発言数
const TALK_RADIUS = 5;           // 声が届く距離(m)=近接会話ゲート
let guests: Guest[] = [];
try { if (GUESTS_PATH !== undefined) guests = JSON.parse(readFileSync(GUESTS_PATH, 'utf8')) as Guest[]; } catch { /* 初回 */ }
const saveGuests = (): void => { try { if (GUESTS_PATH !== undefined) writeFileSync(GUESTS_PATH, JSON.stringify(guests, null, 1)); } catch { /* noop */ } };
const bannedSids = (): string[] => { try { return BAN_PATH !== undefined ? (JSON.parse(readFileSync(BAN_PATH, 'utf8')) as string[]) : []; } catch { return []; } };
const guestKeyOf = (sid: string): string => createHash('sha256').update(`guest:${sid}`).digest('hex').slice(0, 24);
const guestBySid = (sid: string): Guest | undefined => guests.find((g) => g.sid === sid);
const guestByKey = (vk: string): Guest | undefined => guests.find((g) => g.key === vk);
const guestDaily = new Map<string, { day: string; n: number }>();

// M206b: βテスト期間 — world-beta.json(sidの配列)が存在して空でない間は、載っている個体だけ昇格可。
// 全公開に切り替えるときはファイルを消すか [] にする(再起動不要)
const BETA_PATH = VISITORS_PATH !== undefined ? join(VISITORS_PATH, '..', 'world-beta.json') : undefined;
const betaSids = (): string[] | null => {
  try {
    if (BETA_PATH === undefined) return null;
    const a = JSON.parse(readFileSync(BETA_PATH, 'utf8')) as string[];
    return Array.isArray(a) && a.length > 0 ? a : null;
  } catch { return null; }
};

function handleGuestJoin(body: Record<string, unknown>): { code: number; res: unknown } {
  const sid = String(body['sid'] ?? '');
  const name = String(body['name'] ?? '').trim().slice(0, 12);
  if (!/^[0-9a-f]{16}$/.test(sid)) return { code: 400, res: { error: 'sidが不正' } };
  if (bannedSids().includes(sid)) return { code: 403, res: { error: 'この世界には入れません' } };
  const beta = betaSids();
  if (beta !== null && !beta.includes(sid)) {
    return { code: 403, res: { error: 'いまはテスト期間中(βテスターのみ)。もうすぐみんなも入れるようになるよ!', beta: true } };
  }
  if (name === '' || NG_WORDS.test(name)) return { code: 400, res: { error: 'その名前は使えない' } };
  if (RESERVED_NAME.test(name)) return { code: 400, res: { error: 'その名前は世界の住人のもの' } };
  // 同時歩行の上限(既に歩いている本人は再入場OK)
  const activeGuests = [...visitorStates.keys()].filter((k) => guestByKey(k) !== undefined);
  const myKey = guestKeyOf(sid);
  if (!activeGuests.includes(myKey) && activeGuests.length >= GUEST_MAX_ACTIVE) {
    return { code: 429, res: { error: `いまは満員(${GUEST_MAX_ACTIVE}人)。すこし待ってね` } };
  }
  const now = new Date().toISOString();
  const g = guestBySid(sid);
  if (g === undefined) guests.push({ sid, name, key: myKey, firstAt: now, lastAt: now });
  else { g.name = name; g.lastAt = now; }
  saveGuests();
  log(`ゲスト昇格: ${name} [${sid.slice(0, 8)}]`);
  return { code: 200, res: { ok: true, vk: myKey } };
}

/** 招待客(名簿)とゲストの両方を引く。ゲストの見た目はsid由来=観戦時代と同じ紋と色 */
function speakerOf(vk: string): { name: string; kind: 'invite' | 'guest'; traitSeed: string; sid?: string } | undefined {
  const v = loadVisitors().find((x) => x.key === vk);
  if (v !== undefined) return { name: v.name, kind: 'invite', traitSeed: vk };
  const g = guestByKey(vk);
  if (g !== undefined) return { name: g.name, kind: 'guest', traitSeed: g.sid, sid: g.sid };
  return undefined;
}

function handleVisitorChat(body: Record<string, unknown>): { code: number; res: unknown } {
  const vk = String(body['vk'] ?? '');
  const sp = speakerOf(vk);
  if (sp === undefined) return { code: 401, res: { error: '招待キーが違う' } };
  if (sp.sid !== undefined && bannedSids().includes(sp.sid)) return { code: 403, res: { error: 'この世界には入れません' } };
  const limit = sp.kind === 'guest' ? GUEST_TEXT_MAX : 120;
  const text = String(body['text'] ?? '').trim().slice(0, limit);
  if (text === '') return { code: 400, res: { error: '空の発言' } };
  const rate = sp.kind === 'guest' ? GUEST_RATE_MS : 5_000;
  const last = visitorLastAt.get(vk) ?? 0;
  if (Date.now() - last < rate) return { code: 429, res: { error: `ゆっくり話してね(${Math.round(rate / 1000)}秒に1回)` } };
  if (NG_WORDS.test(text)) return { code: 400, res: { error: 'その言葉は世界に持ち込めない' } };
  if (sp.kind === 'guest') {
    const day = new Date().toLocaleDateString('sv-SE');
    const d = guestDaily.get(vk) ?? { day, n: 0 };
    if (d.day !== day) { d.day = day; d.n = 0; }
    if (d.n >= GUEST_DAILY_MAX) return { code: 429, res: { error: 'きょうはたくさん話したね。また明日' } };
    d.n++;
    guestDaily.set(vk, d);
    // 近接会話ゲート: 声は近くでしか届かない(叫べない世界=物理で守る)。
    // 位置未登録の声は世界に立っていない=届かない(未登録での素通りを許さない)
    const me = visitorStates.get(vk);
    if (me === undefined) return { code: 200, res: { ok: false, detail: 'まだ世界に立っていないよ(ページを開き直してみて)' } };
    const her = world.avatarPos();
    if (her !== null && Math.hypot(me.x - her.x, me.z - her.z) > TALK_RADIUS) {
      return { code: 200, res: { ok: false, detail: 'とおくて聞こえない。ヒナタのそばに行って話しかけてね' } };
    }
  }
  visitorLastAt.set(vk, Date.now());
  world.visitorChat(sp.name.slice(0, 12), text);
  log(`訪問者の声: ${sp.name}「${text.slice(0, 40)}」`);
  return { code: 200, res: { ok: true } };
}

// ---- M174(A工事): 公開観戦面 — 見るだけの窓 ----
// トンネル(cloudflared等)をこのポートへ向ける。書き込みAPI・鍵付きAPIは一切存在しない別サーバ。
// 世界のURL公開そのものはオーナー承認制(鉄則)。ここは「窓を作る」だけ
const PUBLIC_PORT = arg('public-port');
if (PUBLIC_PORT !== undefined) {
  const pub = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost`);
      const path = url.pathname;
      // M195: visit(招待)のクエリを剥がさない — viewer/visitどちらでもないときだけ観戦へ誘導
      if (req.method === 'GET' && (path === '/' || path === '/world.html') && url.searchParams.get('viewer') !== '1' && url.searchParams.get('visit') !== '1') {
        res.writeHead(302, { location: '/world.html?viewer=1' });
        res.end();
        return;
      }
      if (req.method === 'GET' && path.startsWith('/tts/')) {
        serveStatic(TTS_DIR, path.slice('/tts/'.length), res, false);
        return;
      }
      if (req.method === 'GET' && (path === '/world.html' || path.startsWith('/assets') || path.startsWith('/motions') || path.startsWith('/avatars') || /\.(js|css|png|svg|vrm|glb|fbx|webmanifest|ico)$/.test(path))) {
        serveStatic(STATIC_DIR!, path.slice(1), res, false);
        return;
      }
      // M213: 世界アプリ(としょかん等)の読み取り配信。見学者もダブルタップで開ける
      if (req.method === 'GET' && path.startsWith('/world-apps/') && APPS_DIR !== undefined) {
        let rel = path.slice('/world-apps/'.length);
        if (rel === '' || rel.endsWith('/')) rel += 'index.html';
        else if (!rel.split('/').pop()!.includes('.')) rel += '/index.html';
        serveStatic(APPS_DIR, rel, res, true);
        return;
      }
      if (req.method === 'GET' && path === '/api/world/spectate') {
        if (publicSseCount >= 25) { res.writeHead(503); res.end('満員'); return; }
        publicSseCount++;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const restore = world.restorePayload();
        if (restore !== null) res.write(`event: world:event\ndata: ${JSON.stringify(restore)}\n\n`);
        const offEvent = bus.subscribe('world:event', (payload) => res.write(`event: world:event\ndata: ${JSON.stringify(payload)}\n\n`));
        const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 20_000);
        req.on('close', () => { clearInterval(ping); offEvent(); publicSseCount--; });
        return;
      }
      // M195: SSEが堰き止められる回線(cloudflaredトンネル実測)向けのポーリング窓。読み取り専用。
      // stampは構造コマンドの内容ハッシュ=変化した時だけcmdsを返す(チャット・アバターは毎回)
      if (req.method === 'GET' && path === '/api/world/poll') {
        const restore = world.restorePayload();
        const structural = (restore?.cmds ?? []).filter((c) => c.type !== 'chat_restore' && c.type !== 'avatar_state');
        const json = JSON.stringify(structural);
        let h = 5381;
        for (let i = 0; i < json.length; i++) h = ((h * 33) ^ json.charCodeAt(i)) >>> 0;
        const stamp = `${h}:${structural.length}`;
        const av = restore?.cmds.find((c) => c.type === 'avatar_state');
        sendJson(res, 200, {
          stamp,
          cmds: url.searchParams.get('stamp') === stamp ? [] : structural,
          chat: world.chatHistory(20),
          avatar: av ?? null,
          visitors: allGhosts(),
        });
        return;
      }
      // M196: 立ち見客の入場/心拍(15秒毎)。声は出せない(chatはvk必須のまま)
      if (req.method === 'POST' && path === '/api/world/spectator') {
        void readJsonBody(req).then((body) => {
          const { code, res: r } = handleSpectatorBeat(body);
          sendJson(res, code, r);
        });
        return;
      }
      // 観戦ページのhello/state報告は受けるふりだけして捨てる(書き込み経路は公開面に存在しない)
      if (req.method === 'POST' && path === '/api/world/event') {
        void readJsonBody(req).then(() => sendJson(res, 200, { ok: true }));
        return;
      }
      // M206: 観戦→歩けるゲストへの昇格(sid→決定的な鍵。出禁・予約名・同時上限つき)
      if (req.method === 'POST' && path === '/api/world/guest') {
        void readJsonBody(req).then((body) => {
          const { code, res: r } = handleGuestJoin(body);
          sendJson(res, code, r);
        });
        return;
      }
      // M175/M176: 訪問者の声と足(招待キー・レート制限・NG語つき)— 公開面で唯一の書き込み
      if (req.method === 'POST' && path === '/api/world/visitor') {
        void readJsonBody(req).then((body) => {
          const kind = String(body['kind'] ?? 'chat');
          const { code, res: r } = kind === 'pos' ? handleVisitorPos(body) : handleVisitorChat(body);
          sendJson(res, code, r);
        });
        return;
      }
      res.writeHead(404); res.end();
    } catch {
      res.writeHead(500); res.end();
    }
  });
  // M196b: WebSocket押し出し口(サーバ→クライアントの一方通行)。cloudflaredトンネルは
  // SSEを堰き止めるがWebSocketは通す=トンネル観戦のリアルタイム化。クライアントの
  // フレームは一切読まない(声も操作も受け付けない=読み取り専用の原則は維持)
  const wsFrame = (data: string): Buffer => {
    const payload = Buffer.from(data, 'utf8');
    const len = payload.length;
    let header: Buffer;
    if (len < 126) header = Buffer.from([0x81, len]);
    else if (len < 65_536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([header, payload]);
  };
  pub.on('upgrade', (req, socket) => {
    try {
      const u = new URL(req.url ?? '/', 'http://localhost');
      const key = String(req.headers['sec-websocket-key'] ?? '');
      if (u.pathname !== '/api/world/ws' || key === '' || publicSseCount >= 25) { socket.destroy(); return; }
      const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      publicSseCount++;
      const send = (event: string, payload: unknown): void => {
        try { socket.write(wsFrame(JSON.stringify({ event, data: payload }))); } catch { /* 切断済み */ }
      };
      const restore = world.restorePayload();
      if (restore !== null) send('world:event', restore);
      const offEvent = bus.subscribe('world:event', (payload) => send('world:event', payload));
      const ping = setInterval(() => send('ping', {}), 20_000);
      let done = false;
      const cleanup = (): void => {
        if (done) return;
        done = true;
        clearInterval(ping);
        offEvent();
        publicSseCount--;
      };
      socket.on('close', cleanup);
      socket.on('error', cleanup);
      socket.on('data', () => { /* クライアントからは何も受け付けない */ });
    } catch { socket.destroy(); }
  });
  pub.listen(Number(PUBLIC_PORT), '127.0.0.1', () => log(`公開観戦面(読み取り専用) http://127.0.0.1:${PUBLIC_PORT}/world.html?viewer=1`));
}

process.on('SIGTERM', () => { executorProc?.kill(); process.exit(0); });
process.on('SIGINT', () => { executorProc?.kill(); process.exit(0); });
