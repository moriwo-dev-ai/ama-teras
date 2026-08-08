import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import type {
  AgentStatusView,
  ApprovalDecision,
  ApprovalRequestPayload,
  ChatImageInput,
  ChatMode,
  EvolutionEvent,
  EvolutionJobSummary,
  HistoryMessageView,
  PluginErrorInfo,
  RemoteSnapshot,
  ToolInfo,
} from '../../shared/types';
import type { AuditEntry } from '../audit';
import { validateChatImages } from '../core/chatImages';
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
  /** M14-3: images は任意(後方互換)。スマホからの写真添付 */
  chatSend(text: string, mode: ChatMode, images?: ChatImageInput[]): { sessionId: string };
  chatCancel(sessionId: string): void;
  approvalRespond(id: string, decision: ApprovalDecision): void;
  toolsList(): { tools: ToolInfo[]; errors: PluginErrorInfo[] };
  evolutionList(): EvolutionJobSummary[];
  evolutionEnqueue(
    description: string,
    expectedIO: string,
    scope?: import('../../shared/types').EvolutionScope,
  ): Promise<{ jobId: number }>;
  evolutionPromoteRespond(jobId: number, approved: boolean): void;
  /**
   * M99: ツールの公開・再検証・獲得能力をスマホからも扱う(未注入なら 501 を返す)。
   * 送信の掟は据え置き: uploadPlan で全文を返し、upload には承認した全文を添えさせる
   */
  evolutionCapabilities?(): Promise<unknown[]>;
  pluginsPublishedList?(): Promise<Record<string, import('../../shared/types').PublishedPluginInfo>>;
  pluginsUploadPlan?(toolName: string): Promise<import('../../shared/types').PluginUploadPlanResult>;
  pluginsReverify?(toolName: string): Promise<{ ok: boolean; toolName: string; message: string }>;
  pluginsUpload?(
    toolName: string,
    approvedPreview: string,
    draft: boolean,
  ): Promise<import('../../shared/types').PluginUploadResult>;
  /** M99-17: スマホからの秘密登録(許可スロットはサーバ側で制限。値は絶対に返さない) */
  secretsSet?(slot: string, value: string): Promise<{ ok: boolean }>;
  secretsStatus?(): Promise<Record<string, boolean>>;
  getStatus(): AgentStatusView;
  getHistoryView(): HistoryMessageView[];
  /** M22: 表示中の会話IDと実行中ラン一覧(snapshot用) */
  getCurrentConversationId(): string;
  runsList(): import('../../shared/types').RunInfo[];
  getPendingApprovals(): ApprovalRequestPayload[];
  getPendingPromotionRequests(): Extract<EvolutionEvent, { kind: 'promotion_request' }>[];
  /** M15.1: セッション一覧と切替(切替はworkspace追従込み。実行中はservice側ガードで拒否) */
  sessionsList(): Promise<import('../../shared/types').SessionMeta[]>;
  sessionOpen(id: string): Promise<import('../../shared/types').SessionLoadResult>;
  /** M23-3: スマホからの新規チャット */
  sessionNew(): { ok: boolean; message?: string };
  /** M17-2: 自律モードの切替(ONはHTTP層で confirmed:true を強制) */
  setAutonomous(on: boolean): { on: boolean };
}

export interface RemoteServerDeps {
  facade: RemoteFacade;
  bus: EventBus;
  /** M23-2/3: 使用量サマリと、安全なサブセット限定の設定読み書き(未注入なら該当APIは404) */
  usageSummary?: () => import('../../shared/types').UsageSummary;
  remoteSettings?: {
    get(): Record<string, unknown>;
    set(patch: Record<string, unknown>): Record<string, unknown>;
  };
  auth: RemoteAuth;
  /** remote-ui のビルド出力(out/remote-ui)。無ければ静的配信は404 */
  staticDir: string;
  /** M120: 世界アプリの配信ルート(userData/world-apps)。未指定なら /world-apps/* は404 */
  worldAppsDir?: string;
  /** M121: 録画の保存先(userData/world-recordings)。未指定なら録画アップロードは404 */
  worldRecordingsDir?: string;
  auditTail: (limit: number) => AuditEntry[];
  /** SSE keep-alive 間隔 ms(テスト用に注入可) */
  heartbeatMs?: number;
  /** M34-6: 運営(TAKAMA-gahara)のリモート対応。未注入なら /api/ops/* は404 */
  operations?: RemoteOperationsFacade;
  /** M115: 世界(WORLD)ブリッジ。未注入なら /api/world/* は404 */
  world?: {
    onPageEvent(ev: import('../../shared/types').WorldPageEvent): { ok: boolean };
    /** M115-5: 観戦モードの初期表示(現在の世界の復元バッチ)。未実装なら初期表示なし */
    restorePayload?(): import('../../shared/types').WorldPushPayload | null;
    /**
     * M117-B: 世界の常時実行ページ(アプリ自身が開く隠しウィンドウ)用の実行キー。
     * ループバック+このキー一致なら POST /api/world/event をトークンなしで許可する。
     * キーは起動ごとにランダム生成され、main→隠しウィンドウのURLでのみ受け渡される
     */
    executorKey?: string;
    /**
     * b案(AI生命体): 生命体デーモン(別プロセス)の世界コマンド投入口。
     * ループバック+実行キー限定。WorldManager.act に委譲(=検証・配信ガード・ackを共有)
     */
    act?(cmds: import('../../shared/types').WorldCommand[]): Promise<{ ok: boolean; detail: string }>;
  };
}

/** M34-6: 運営リモートAPIの窓口(実装は ipc.ts が OperationsManager を包んで注入) */
export interface RemoteOperationsFacade {
  summary(): Promise<{
    enabled: boolean;
    clocks: import('../../shared/types').GodClockJob[];
    inbox: (import('../../shared/types').InboxItem & { read: boolean })[];
    latest: import('../../shared/types').MetricsSnapshot | null;
    pendingIwato: import('../../shared/types').IwatoRequestPayload[];
  }>;
  threadList(): import('../../shared/types').OpsThreadMessage[];
  threadSend(text: string): Promise<import('../../shared/types').OpsThreadMessage[]>;
  batches(): import('../../shared/types').ApprovalBatch[];
  batchRespond(batchId: string, itemId: string, approved: boolean): Promise<{ ok: boolean; detail: string }>;
  /** 岩戸ゲートの応答(リモート経由フラグ込みでauditされる)。falseなら該当承認なし */
  iwatoRespond(id: string, approved: boolean): boolean;

  // ---- M40: スマホからデスクトップ同等の運営操作をするための窓口 ----
  /** M39: 同種(媒体×アクション)の一括承認。X/はてブは links を返す(スマホのブラウザで開く) */
  bulkRespond(
    batchId: string,
    itemIds: string[],
    approved: boolean,
  ): Promise<import('../../shared/operations').BulkRespondResult>;
  /** 発信ドラフト+効果測定+行き先候補(リポジトリ)。運営タブのドラフト欄に相当 */
  drafts(): Promise<{
    drafts: import('../../shared/types').OperationsDraft[];
    impacts: import('../../shared/types').ImpactEntry[];
    repos: string[];
  }>;
  draftUpdate(
    id: string,
    patch: { status?: 'draft' | 'posted' | 'discarded'; body?: string; title?: string; media?: string },
  ): import('../../shared/types').OperationsDraft | null;
  /** リリースノート → GitHub Release(下書き)。岩戸ゲート承認はスマホ側に出る */
  draftRelease(draftId: string, repo: string, tag: string): Promise<{ ok: boolean; detail: string }>;
  /** 記事アウトライン → Zenn記事化(published: false でコミット) */
  draftZennArticle(draftId: string): Promise<{ ok: boolean; detail: string }>;
  /** M99-14: 未投稿ドラフトをBlueskyへ(岩戸ゲート経由) */
  draftBluesky(draftId: string): Promise<{ ok: boolean; detail: string }>;
  /** M99-16: 記事ドラフトをdev.toへ(岩戸承認制) */
  draftDevto(draftId: string, published: boolean): Promise<{ ok: boolean; detail: string }>;
  /** 神々の時計の操作(稼働/間隔/予算/🔒解錠) */
  clockUpdate(
    id: string,
    patch: { intervalMin?: number; enabled?: boolean; dailyTokenBudget?: number; budgetSetByUser?: boolean },
  ): import('../../shared/types').GodClockJob | null;
  /** 神を今すぐ1回動かす(観測・下書き生成・トリアージ・神議) */
  godRun(godId: string): Promise<{ ok: boolean; detail: string; tokensUsed: number }>;

  // ---- M60: スマホからも「公開」まで届かせる ----
  /**
   * 下書きリリースの公開。**staged(公開待ち)を実際に外へ出す唯一の操作**。
   * スマホから公開できないせいで、Zenn2本・Release2件が誰にも読まれないまま
   * 埋もれていた(神議も「公開作業の未実施がボトルネック」と診断した)。
   * 押した瞬間に全利用者へ更新通知が飛ぶので、岩戸ゲートを必ず通る
   */
  releasePublish(repo: string, tag: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * M73: Zenn記事の公開(published: false → true)。Releaseと同じく岩戸ゲート(全文確認)を通る。
   * 「記事化」ボタンはコミットまでしかせず、公開だけが人間の手作業として残っていた
   */
  zennPublish(slug: string): Promise<{ ok: boolean; detail: string }>;
  zennPublishable(): { slug: string; title: string; blocked: string | null }[];
  /** M77: published:true なのにZennが同期していない記事の再デプロイ */
  zennRedeploy(slug: string): Promise<{ ok: boolean; detail: string }>;
  zennStuck(): Promise<{ slug: string; title: string }[]>;
  /**
   * リリースの版情報(前回タグ・次の版の候補・package.jsonとのズレ・**公開待ちの下書きリリース**)。
   * pendingDraft.assets が空なら公開させない(中身の無いリリースを世に出さないため)
   */
  releaseInfo(repo: string): Promise<{
    latestTag: string | null;
    appVersion: string;
    suggestions: { patch: string | null; minor: string | null; major: string | null };
    mismatch: boolean;
    pendingDraft: { tag: string; assets: string[] } | null;
  }>;
  /** メトリクスの時系列(前回比を出すために複数点が要る。PCは30件見ている) */
  history(limit: number): import('../../shared/types').MetricsSnapshot[];
  /** アダプタの稼働状況(gh未検出などの警告がスマホから見えない問題) */
  adapterStatus(): Promise<{ enabled: boolean; ghDetected: boolean; adapters: { id: string; available: boolean }[] }>;

  // ---- M62: PCにあってスマホに無かったもの(出先で判断が止まる) ----
  /** 週報の生成(下書きとして残る) */
  weeklyReport(): Promise<import('../../shared/types').OperationsDraft | null>;
  /** Issue/PRのトリアージ(所見・CI状態・返信下書き) */
  triage(): Promise<import('../../shared/types').TriageCard[]>;
  /** 仲間候補の一覧と、残す/破棄 */
  candidates(): import('../../shared/types').CommunityCandidate[];
  candidateResolve(id: string, status: 'kept' | 'discarded'): import('../../shared/types').CommunityCandidate | null;
  /** 媒体ごとの戦略ボード(どこに効いているか) */
  strategyBoard(): import('../../shared/types').MediaStrategyEntry[];
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
/**
 * M15.1: /api/chat のみ画像添付(base64)のため大きめに許可する。
 * remote-ui は送信前に長辺1568pxへ圧縮するが、複数枚+余裕を見て24MB
 */
const CHAT_BODY_BYTES = 24 * 1024 * 1024;

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

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
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

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const raw = (await readBody(req, maxBytes)).toString('utf8');
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
    if (path === '/api/world/spectate') return this.handleWorldSpectate(req, res);
    // M141: 音声合成プロキシ(ループバック限定)。VOICEVOXエンジン(127.0.0.1:50021)へ中継する。
    // 配信ページ(観戦=トークンなし)が使うため、観戦SSEと同じ境界(同一PC限定)で守る
    if (path === '/api/world/tts' && req.method === 'GET') return this.handleWorldTts(req, res, url);
    // M121: 実行係ページからの録画アップロード(webm)。実行キー+ループバック限定
    if (path === '/api/world/recording' && req.method === 'POST' && this.isWorldExecutor(req, url)) {
      const dir = this.deps.worldRecordingsDir;
      if (dir === undefined) throw new HttpError(404, 'recordings 未設定');
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        total += (chunk as Buffer).length;
        if (total > 200 * 1024 * 1024) throw new HttpError(413, '録画が大きすぎる(200MB上限)');
        chunks.push(chunk as Buffer);
      }
      const file = join(dir, `rec-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`);
      await writeFile(file, Buffer.concat(chunks));
      return sendJson(res, 200, { ok: true, file });
    }
    // b案(AI生命体): 生命体デーモン(別プロセス)の世界コマンド投入。ループバック+実行キー限定
    if (path === '/api/world/command' && req.method === 'POST' && this.isWorldExecutor(req, url)) {
      if (this.deps.world?.act === undefined) throw new HttpError(404, 'world act 未注入');
      const body = await readJsonBody(req);
      const cmds = body['cmds'];
      if (!Array.isArray(cmds) || cmds.length === 0 || cmds.length > 10) {
        throw new HttpError(400, 'cmds(1〜10件の配列)が必要');
      }
      // 生命体はアイドル演出専用: 破壊系・録画・アプリ操作系は経路ごと遮断する(誤動作の爆風半径を絞る)
      const allowed = new Set(['say', 'motion', 'move_to', 'face']);
      const banned = (cmds as { type?: unknown }[]).find((c) => typeof c.type !== 'string' || !allowed.has(c.type));
      if (banned !== undefined) throw new HttpError(400, `生命体デーモンが使えるのは say/motion/move_to/face のみ`);
      return sendJson(res, 200, await this.deps.world.act(cmds as import('../../shared/types').WorldCommand[]));
    }
    // M117-B: 常時実行ページ(ループバック+実行キー)はトークンなしで世界イベントを送れる
    if (path === '/api/world/event' && req.method === 'POST' && this.isWorldExecutor(req, url)) {
      if (!this.deps.world) throw new HttpError(404, 'world ブリッジ未注入');
      const body = await readJsonBody(req);
      if (typeof body['kind'] !== 'string') throw new HttpError(400, 'kind が必要');
      return sendJson(res, 200, this.deps.world.onPageEvent(body as unknown as import('../../shared/types').WorldPageEvent));
    }
    if (path.startsWith('/api/')) return this.handleApi(req, res, url);
    if (req.method === 'GET') return this.handleStatic(path, res);
    throw new HttpError(405, 'method not allowed');
  }

  /**
   * M115-5: 世界の観戦モード(読み取り専用SSE)。**ループバック(同一PC)限定・トークン不要**。
   * 中継するのは world:event(世界コマンド)だけ — チャット本文・承認・設定など他チャネルは
   * 一切流さない。書き込み経路もない(POST /api/world/event は従来どおり要トークン)。
   * 用途: 開発/QAでデスクトップ側から世界の見た目を確認する
   */
  private handleWorldSpectate(req: IncomingMessage, res: ServerResponse): void {
    const ip = req.socket.remoteAddress ?? '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLoopback) throw new HttpError(403, '観戦モードは同一PC(ループバック)限定');
    if (!this.deps.world) throw new HttpError(404, 'world ブリッジ未注入');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    write('snapshot', {});
    const restore = this.deps.world.restorePayload?.() ?? null;
    if (restore !== null) write('world:event', restore);
    const unsubscribe = this.deps.bus.subscribe('world:event', (payload) => write('world:event', payload));
    // M141: 稼働可視化を観戦(=OBS配信画面)にも流す。「作ってる間、何をしてるか分からない」対策。
    // 中継するのは進捗系のみ・許可フィールドだけを写経し、パス風文字列はサーバ側で必ずマスクする
    const unsubscribeWork = this.deps.bus.subscribe('chat:event', (raw) => {
      const ev = raw as Record<string, unknown>;
      const kind = ev['kind'];
      if (kind !== 'status' && kind !== 'tool_start' && kind !== 'tool_progress' && kind !== 'tool_result') return;
      const mask = (s: unknown): string | undefined =>
        typeof s === 'string'
          ? s.replace(/[A-Za-z]:[\\/][^\s'"]+/g, '…(パス非表示)').replace(/\/(?:home|Users)\/[^\s'"]+/g, '…(パス非表示)')
          : undefined;
      write('chat:event', {
        kind,
        ...(typeof ev['status'] === 'string' ? { status: ev['status'] } : {}),
        ...(typeof ev['name'] === 'string' ? { name: ev['name'] } : {}),
        ...(mask(ev['inputPreview']) !== undefined ? { inputPreview: mask(ev['inputPreview']) } : {}),
        ...(mask(ev['outputTail']) !== undefined ? { outputTail: mask(ev['outputTail']) } : {}),
      });
    });
    const heartbeat = setInterval(() => {
      res.write(': ping\n\n');
    }, this.deps.heartbeatMs ?? 25_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribeWork();
      this.sseCleanups.delete(cleanup);
      res.end();
    };
    this.sseCleanups.add(cleanup);
    req.on('close', cleanup);
  }

  /**
   * M141: VOICEVOX中継。/api/world/tts?text=…&spk=2 → audio/wav。
   * エンジン未起動なら503(ページ側は黙って字幕のみにフォールバック)。
   * クレジット表記義務(VOICEVOX:キャラ名)は配信概要欄で果たす運用
   */
  private async handleWorldTts(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const ip = req.socket.remoteAddress ?? '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLoopback) throw new HttpError(403, 'ttsは同一PC(ループバック)限定');
    const text = (url.searchParams.get('text') ?? '').slice(0, 300);
    if (text.trim() === '') throw new HttpError(400, 'text が必要');
    const spk = /^\d{1,3}$/.test(url.searchParams.get('spk') ?? '') ? url.searchParams.get('spk') : '2';
    const base = 'http://127.0.0.1:50021';
    try {
      const q = await fetch(`${base}/audio_query?speaker=${spk}&text=${encodeURIComponent(text)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(8_000),
      });
      if (!q.ok) throw new Error(`audio_query ${q.status}`);
      const query = (await q.json()) as Record<string, unknown>;
      query['speedScale'] = 1.1; // 配信のテンポ優先(素の1.0はややゆっくり)
      const syn = await fetch(`${base}/synthesis?speaker=${spk}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(20_000),
      });
      if (!syn.ok) throw new Error(`synthesis ${syn.status}`);
      const wav = Buffer.from(await syn.arrayBuffer());
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
      res.end(wav);
    } catch (err) {
      // エンジン停止中は「声なし配信」に静かに戻る(致命ではない)
      throw new HttpError(503, `VOICEVOXエンジンに接続できない: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** M117-B: 常時実行ページ判定(ループバック+起動ごとの実行キー一致) */
  private isWorldExecutor(req: IncomingMessage, url: URL): boolean {
    const key = this.deps.world?.executorKey;
    if (key === undefined || key === '') return false;
    const ip = req.socket.remoteAddress ?? '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    return isLoopback && url.searchParams.get('k') === key;
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
        // M15.1: 画像添付(base64)を受けるためこのルートだけ上限を拡大
        const body = await readJsonBody(req, CHAT_BODY_BYTES);
        const text = body['text'];
        if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'text が必要');
        const mode: ChatMode = body['mode'] === 'plan' ? 'plan' : 'normal';
        // M14-3: スマホからの画像添付(検証はIPCと共通)
        let images: ChatImageInput[] | undefined;
        try {
          images = validateChatImages(body['images']);
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : 'images が不正');
        }
        return sendJson(res, 200, facade.chatSend(text, mode, images));
      }

      case 'GET /api/sessions': {
        return sendJson(res, 200, { sessions: await facade.sessionsList() });
      }

      case 'POST /api/sessions/load': {
        const body = await readJsonBody(req);
        const id = body['id'];
        if (typeof id !== 'string' || id === '') throw new HttpError(400, 'id が必要');
        // 実行中ガード・workspace追従は service 側(sessionOpen)で強制される
        return sendJson(res, 200, await facade.sessionOpen(id));
      }

      case 'POST /api/world/event': {
        // M115: 世界ページ→main。state/chat/ack を WorldManager へ渡す(未注入なら404)
        if (!this.deps.world) throw new HttpError(404, 'world ブリッジ未注入');
        const body = await readJsonBody(req);
        const kind = body['kind'];
        if (typeof kind !== 'string') throw new HttpError(400, 'kind が必要');
        const r = this.deps.world.onPageEvent(body as unknown as import('../../shared/types').WorldPageEvent);
        return sendJson(res, 200, r);
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
        const scope = body['scope'];
        if (typeof description !== 'string' || description.trim() === '') {
          throw new HttpError(400, 'description が必要');
        }
        if (typeof expectedIO !== 'string') throw new HttpError(400, 'expectedIO が必要');
        if (scope !== undefined && scope !== 'tool' && scope !== 'renderer' && scope !== 'core') {
          throw new HttpError(400, 'scope が不正(tool/renderer/core)');
        }
        return sendJson(res, 200, await facade.evolutionEnqueue(description, expectedIO, scope));
      }

      // M99: ツールの公開・再検証・獲得能力をスマホからも。
      // 送信の掟は変えない — plan で全文を返し、upload には「見せた全文」を添えさせる
      case 'GET /api/evolution/capabilities': {
        if (facade.evolutionCapabilities === undefined) throw new HttpError(501, 'この環境では未対応');
        return sendJson(res, 200, await facade.evolutionCapabilities());
      }

      case 'GET /api/plugins/published': {
        if (facade.pluginsPublishedList === undefined) throw new HttpError(501, 'この環境では未対応');
        return sendJson(res, 200, await facade.pluginsPublishedList());
      }

      case 'POST /api/plugins/upload-plan': {
        if (facade.pluginsUploadPlan === undefined) throw new HttpError(501, 'この環境では未対応');
        const body = await readJsonBody(req);
        const toolName = body['toolName'];
        if (typeof toolName !== 'string' || toolName.trim() === '') {
          throw new HttpError(400, 'toolName が必要');
        }
        return sendJson(res, 200, await facade.pluginsUploadPlan(toolName));
      }

      case 'POST /api/plugins/reverify': {
        if (facade.pluginsReverify === undefined) throw new HttpError(501, 'この環境では未対応');
        const body = await readJsonBody(req);
        const toolName = body['toolName'];
        if (typeof toolName !== 'string' || toolName.trim() === '') {
          throw new HttpError(400, 'toolName が必要');
        }
        return sendJson(res, 200, await facade.pluginsReverify(toolName));
      }

      case 'POST /api/plugins/upload': {
        if (facade.pluginsUpload === undefined) throw new HttpError(501, 'この環境では未対応');
        const body = await readJsonBody(req);
        const toolName = body['toolName'];
        const approvedPreview = body['approvedPreview'];
        const draft = body['draft'];
        if (typeof toolName !== 'string' || toolName.trim() === '') {
          throw new HttpError(400, 'toolName が必要');
        }
        // 全文承認の担保: 下見で見せた全文をそのまま送り返させる(main側でも突き合わせる)
        if (typeof approvedPreview !== 'string' || approvedPreview.trim() === '') {
          throw new HttpError(400, 'approvedPreview(承認した全文)が必要');
        }
        return sendJson(res, 200, await facade.pluginsUpload(toolName, approvedPreview, draft === true));
      }

      case 'POST /api/autonomous': {
        // M17-2: スマホからの切替。ON はデスクトップの危険モーダル同等の明示確認を必須にする
        const body = await readJsonBody(req);
        const on = body['on'];
        if (typeof on !== 'boolean') throw new HttpError(400, 'on(boolean) が必要');
        if (on && body['confirmed'] !== true) {
          throw new HttpError(400, 'ONにはリスク確認(confirmed:true)が必要');
        }
        return sendJson(res, 200, facade.setAutonomous(on));
      }

      case 'POST /api/sessions/new': {
        // M23-3: スマホからの新規チャット(M22で実行中でもブロックされない)
        return sendJson(res, 200, facade.sessionNew());
      }

      case 'GET /api/usage': {
        // M23-2: 使用量サマリ(残高に準ずるもの)
        if (!this.deps.usageSummary) throw new HttpError(404, 'usage 未対応');
        return sendJson(res, 200, this.deps.usageSummary());
      }

      case 'GET /api/settings': {
        // M23-3: 安全なサブセットのみ(tokenHash等は含まれない)
        if (!this.deps.remoteSettings) throw new HttpError(404, 'settings 未対応');
        return sendJson(res, 200, this.deps.remoteSettings.get());
      }

      case 'POST /api/settings': {
        if (!this.deps.remoteSettings) throw new HttpError(404, 'settings 未対応');
        const body = await readJsonBody(req);
        try {
          return sendJson(res, 200, this.deps.remoteSettings.set(body));
        } catch (err) {
          throw new HttpError(400, err instanceof Error ? err.message : '設定が不正');
        }
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

      // ---- M34-6: 運営(TAKAMA-gahara)のリモートフル対応 ----
      // 出先のスマホだけで「運営」が完結する: ダッシュボード閲覧・⛩スレッド・
      // 承認バッチ・岩戸ゲート応答。既存のトークン認証配下(追加の公開経路なし)

      case 'GET /api/ops/summary': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, await this.deps.operations.summary());
      }

      case 'GET /api/ops/thread': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, { messages: this.deps.operations.threadList() });
      }

      case 'POST /api/ops/thread': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        if (typeof body['text'] !== 'string' || body['text'].trim() === '') {
          throw new HttpError(400, 'text(string) が必要');
        }
        return sendJson(res, 200, { messages: await this.deps.operations.threadSend(body['text']) });
      }

      case 'GET /api/ops/batches': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, { batches: this.deps.operations.batches() });
      }

      case 'POST /api/ops/batch-respond': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        if (typeof body['batchId'] !== 'string' || typeof body['itemId'] !== 'string' || typeof body['approved'] !== 'boolean') {
          throw new HttpError(400, 'batchId/itemId(string) と approved(boolean) が必要');
        }
        return sendJson(res, 200, await this.deps.operations.batchRespond(body['batchId'], body['itemId'], body['approved']));
      }

      // ---- M40: スマホからのフル操作(ドラフト・時計・神の手動実行・一括承認)----

      case 'POST /api/ops/bulk-respond': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        const ids = body['itemIds'];
        if (
          typeof body['batchId'] !== 'string' ||
          !Array.isArray(ids) ||
          ids.some((i) => typeof i !== 'string') ||
          typeof body['approved'] !== 'boolean'
        ) {
          throw new HttpError(400, 'batchId(string)/itemIds(string[])/approved(boolean) が必要');
        }
        return sendJson(
          res,
          200,
          await this.deps.operations.bulkRespond(body['batchId'], ids as string[], body['approved']),
        );
      }

      case 'GET /api/ops/drafts': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, await this.deps.operations.drafts());
      }

      case 'POST /api/ops/draft-update': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        const patch = body['patch'];
        if (typeof body['id'] !== 'string' || typeof patch !== 'object' || patch === null) {
          throw new HttpError(400, 'id(string) と patch(object) が必要');
        }
        const p = patch as Record<string, unknown>;
        return sendJson(
          res,
          200,
          this.deps.operations.draftUpdate(body['id'], {
            ...(p['status'] === 'draft' || p['status'] === 'posted' || p['status'] === 'discarded'
              ? { status: p['status'] }
              : {}),
            ...(typeof p['media'] === 'string' ? { media: p['media'] } : {}),
          }),
        );
      }

      case 'POST /api/ops/draft-release': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        if (
          typeof body['draftId'] !== 'string' ||
          typeof body['repo'] !== 'string' ||
          typeof body['tag'] !== 'string'
        ) {
          throw new HttpError(400, 'draftId/repo/tag(string) が必要');
        }
        return sendJson(
          res,
          200,
          await this.deps.operations.draftRelease(body['draftId'], body['repo'], body['tag']),
        );
      }

      case 'GET /api/secrets/status': {
        if (facade.secretsStatus === undefined) throw new HttpError(501, 'この環境では未対応');
        return sendJson(res, 200, await facade.secretsStatus());
      }

      case 'POST /api/secrets': {
        if (facade.secretsSet === undefined) throw new HttpError(501, 'この環境では未対応');
        const bs = await readJsonBody(req);
        const slot = bs['slot'];
        const value = bs['value'];
        // M99-17: スマホから登録できるのは devto のみ(最小権限。他スロットはデスクトップで)
        if (slot !== 'devto') throw new HttpError(400, 'このスロットはスマホから登録できない(devtoのみ)');
        if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'value(string) が必要');
        return sendJson(res, 200, await facade.secretsSet(slot, value.trim()));
      }

      case 'POST /api/ops/draft-devto': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const b16 = await readJsonBody(req);
        if (typeof b16['draftId'] !== 'string') throw new HttpError(400, 'draftId(string) が必要');
        return sendJson(res, 200, await this.deps.operations.draftDevto(b16['draftId'], b16['published'] === true));
      }

      case 'POST /api/ops/draft-bluesky': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const b99 = await readJsonBody(req);
        if (typeof b99['draftId'] !== 'string') throw new HttpError(400, 'draftId(string) が必要');
        return sendJson(res, 200, await this.deps.operations.draftBluesky(b99['draftId']));
      }

      case 'POST /api/ops/draft-zenn': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        if (typeof body['draftId'] !== 'string') throw new HttpError(400, 'draftId(string) が必要');
        return sendJson(res, 200, await this.deps.operations.draftZennArticle(body['draftId']));
      }

      case 'POST /api/ops/clock-update': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        const patch = body['patch'];
        if (typeof body['id'] !== 'string' || typeof patch !== 'object' || patch === null) {
          throw new HttpError(400, 'id(string) と patch(object) が必要');
        }
        const p = patch as Record<string, unknown>;
        return sendJson(
          res,
          200,
          this.deps.operations.clockUpdate(body['id'], {
            ...(typeof p['intervalMin'] === 'number' ? { intervalMin: p['intervalMin'] } : {}),
            ...(typeof p['enabled'] === 'boolean' ? { enabled: p['enabled'] } : {}),
            ...(typeof p['dailyTokenBudget'] === 'number' ? { dailyTokenBudget: p['dailyTokenBudget'] } : {}),
            // 🔓 解錠のみ(施錠は予算設定と同時に自動で立つ)
            ...(p['budgetSetByUser'] === false ? { budgetSetByUser: false } : {}),
          }),
        );
      }

      case 'POST /api/ops/god-run': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        if (typeof body['godId'] !== 'string') throw new HttpError(400, 'godId(string) が必要');
        return sendJson(res, 200, await this.deps.operations.godRun(body['godId']));
      }

      // ---- M60: 公開と、その判断に要る情報をスマホへ ----
      case 'POST /api/ops/release-publish': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        const repo = body['repo'];
        const tag = body['tag'];
        if (typeof repo !== 'string' || typeof tag !== 'string') throw new HttpError(400, 'repo/tag(string) が必要');
        return sendJson(res, 200, await this.deps.operations.releasePublish(repo, tag));
      }

      // M73: Zennの公開もスマホから(Releaseと同じ岩戸ゲート)
      case 'POST /api/ops/zenn-publish': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        const slug = body['slug'];
        if (typeof slug !== 'string') throw new HttpError(400, 'slug(string) が必要');
        return sendJson(res, 200, await this.deps.operations.zennPublish(slug));
      }

      case 'POST /api/ops/zenn-redeploy': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        const slug = body['slug'];
        if (typeof slug !== 'string') throw new HttpError(400, 'slug(string) が必要');
        return sendJson(res, 200, await this.deps.operations.zennRedeploy(slug));
      }

      case 'GET /api/ops/zenn-stuck': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, { articles: await this.deps.operations.zennStuck() });
      }

      case 'GET /api/ops/zenn-publishable': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, { articles: this.deps.operations.zennPublishable() });
      }

      case 'GET /api/ops/release-info': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const repo = url.searchParams.get('repo') ?? '';
        if (repo === '') throw new HttpError(400, 'repo が必要');
        return sendJson(res, 200, await this.deps.operations.releaseInfo(repo));
      }

      case 'GET /api/ops/history': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const limit = Number(url.searchParams.get('limit') ?? '30');
        return sendJson(res, 200, {
          snapshots: this.deps.operations.history(Number.isFinite(limit) ? limit : 30),
        });
      }

      case 'GET /api/ops/adapters': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, await this.deps.operations.adapterStatus());
      }

      // ---- M62: 出先でも「見て・判断して・返す」が完結するように ----
      case 'POST /api/ops/weekly-report': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, { draft: await this.deps.operations.weeklyReport() });
      }

      case 'GET /api/ops/triage': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, { cards: await this.deps.operations.triage() });
      }

      case 'GET /api/ops/candidates': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, { candidates: this.deps.operations.candidates() });
      }

      case 'POST /api/ops/candidate-resolve': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        const id = body['id'];
        const status = body['status'];
        if (typeof id !== 'string' || (status !== 'kept' && status !== 'discarded')) {
          throw new HttpError(400, 'id(string) と status(kept|discarded) が必要');
        }
        return sendJson(res, 200, { candidate: this.deps.operations.candidateResolve(id, status) });
      }

      case 'GET /api/ops/strategy': {
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        return sendJson(res, 200, { entries: this.deps.operations.strategyBoard() });
      }

      case 'POST /api/ops/iwato-respond': {
        // 岩戸ゲート(外部発信の最終確認)へのリモート応答。auditに「リモート経由」が残る
        if (!this.deps.operations) throw new HttpError(404, 'operations 未対応');
        const body = await readJsonBody(req);
        if (typeof body['id'] !== 'string' || typeof body['approved'] !== 'boolean') {
          throw new HttpError(400, 'id(string) と approved(boolean) が必要');
        }
        const ok = this.deps.operations.iwatoRespond(body['id'], body['approved']);
        return sendJson(res, 200, { ok });
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
      conversationId: facade.getCurrentConversationId(),
      runs: facade.runsList(),
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
    let relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');

    // M120: 世界アプリ(userData/world-apps)の配信。ディレクトリ直指定は index.html へ
    let root = resolve(this.deps.staticDir);
    if (relative.startsWith('world-apps/')) {
      const appsDir = this.deps.worldAppsDir;
      if (appsDir === undefined) throw new HttpError(404, 'not found');
      root = resolve(appsDir);
      relative = relative.slice('world-apps/'.length);
      if (relative === '' ) throw new HttpError(404, 'not found');
      if (relative.endsWith('/')) relative += 'index.html';
      if (!relative.includes('/')) relative += '/index.html';
    }
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
    // M126: 世界アプリのHTMLには操作ヘルパーを自動注入する。エージェントの app_click/app_type/
    // app_read は親ページからの postMessage で届く=ライブ中の sandbox 隔離(別オリジン扱い)でも動く
    if (root !== resolve(this.deps.staticDir) && type.startsWith('text/html')) {
      data = Buffer.concat([data, Buffer.from(WORLD_APP_HELPER, 'utf8')]);
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(data);
  }
}

/** 世界アプリへ注入する操作ヘルパー。親(world.html)からの {amaWorldOp} を実行して結果を返す。
 * M129: window.amaWorld.publish(state) — アプリが自分の状態を世界へ発信し、社の3D(kioskCodeのtick第3引数)に反映できる */
const WORLD_APP_HELPER = `
<script>
(function () {
  window.amaWorld = {
    publish: function (state) {
      try { window.parent.postMessage({ amaWorldState: state }, '*'); } catch (e) {}
    },
  };
  // M142: アプリを開き直した時、親が最後のpublish状態を送り返す(amaWorldRestore)。
  // アプリ側は window.amaWorldOnRestore(state) を定義すればUIを実状態に同期できる
  // (例: 月アプリが進行中の落下タイマーを表示し続ける)。未定義なら amaWorldLastState に保持のみ
  window.addEventListener('message', function (ev) {
    if (ev.data && 'amaWorldRestore' in ev.data) {
      window.amaWorldLastState = ev.data.amaWorldRestore;
      if (typeof window.amaWorldOnRestore === 'function') {
        try { window.amaWorldOnRestore(ev.data.amaWorldRestore); } catch (e) {}
      }
    }
  });
  window.addEventListener('message', function (ev) {
    var req = ev.data && ev.data.amaWorldOp;
    if (!req || typeof req.op !== 'string') return;
    var src = ev.source || window.parent;
    function reply(payload) {
      payload.reqId = req.reqId;
      try { src.postMessage({ amaWorldOpResult: payload }, '*'); } catch (e) {}
    }
    try {
      var el = document.querySelector(req.selector);
      if (!el) { reply({ ok: false, error: 'selector が見つからない: ' + req.selector }); return; }
      if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      if (req.op === 'click') {
        el.click();
      } else if (req.op === 'type') {
        if (el.focus) el.focus();
        if ('value' in el) {
          el.value = req.text == null ? '' : String(req.text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          el.textContent = req.text == null ? '' : String(req.text);
        }
      }
      // op === 'rect'(app_pointの位置取得)/ 'read' は副作用なし
      var r = el.getBoundingClientRect();
      var text = ('value' in el && el.value !== '') ? el.value : (el.textContent || '');
      reply({ ok: true, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, text: String(text).slice(0, 500) });
    } catch (err) {
      reply({ ok: false, error: String((err && err.message) || err) });
    }
  });
})();
</script>`;
