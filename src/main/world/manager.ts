import { readFileSync, writeFileSync } from 'node:fs';
import type { WorldApp, WorldCommand, WorldPageEvent, WorldPushPayload, WorldStateSnapshot } from '../../shared/types';
import type { EventBus } from '../core/events';

/**
 * M115: 世界(WORLD)ブリッジ。エージェントの「身体・キャンバス」となる3D世界ページと
 * main プロセスを結ぶ。輸送は既存インフラのみ(新規依存ゼロ):
 * - main → ページ: EventBus 'world:event' → SSE(/api/events)
 * - ページ → main: POST /api/world/event(RemoteServer が onPageEvent へ渡す)
 *
 * 設計方針:
 * - 世界ページは複数開かれうる(PC+スマホ)。コマンドは全接続へ配り、ack は最初の1件を採用
 *   (全ページが同じ決定的コマンドを実行するので結果は同一。厳密な多端末同期はP2で扱う)
 * - 「接続中か」は最終受信からの経過時間で判定(ページは定期的に state を報告する)
 */

/**
 * b案P2: 世界チャットの振り分け。呼びかけ(ヒナタ/テラ)が最優先、次に指示語、既定は雑談=ヒナタ。
 * 「作って」「開いて」等の作業依頼は思考層(エージェント)へ、それ以外の話しかけは会話層へ。
 * ヒナタのデーモンが落ちている時は呼びかけ「テラちゃん」で必ず思考層に届く(逃げ道を残す)
 */
export function routeWorldChat(text: string): 'hinata' | 'agent' {
  const t = text.trim();
  if (/^(ヒナタ|ひなた)/.test(t)) return 'hinata';
  if (/^(テラ|てら|アマテラス|AMA)/i.test(t)) return 'agent';
  const directive =
    /(作って|つくって|建てて|たてて|直して|なおして|修正|実装|追加して|消して|削除|撤去|動かして|移動して|開いて|ひらいて|閉じて|とじて|起動|実行|やって|して(ほしい|欲しい)|お願い|おねがい|タイマー|セットして|見せて|みせて|見よう|みよう)/;
  return directive.test(t) ? 'agent' : 'hinata';
}

const CONNECT_TIMEOUT_MS = 30_000;
/** M122(2): 世界の記憶。チャットと出来事を正本に永続化する上限(古いものから落ちる) */
const WORLD_LOG_MAX = 200;
/**
 * M115-6: ページ側はワンショット技の完了待ち・sayの読み待ち・move_toの歩行を
 * 直列実行してからackする(=演出時間ぶん遅れる)。長い演出バッチでも失敗扱いに
 * しないよう余裕を持たせる(30コマンド上限×歩行込みの現実的最大)
 */
const ACK_TIMEOUT_MS = 90_000;

export class WorldManager {
  private seq = 0;
  private lastSeenMs = Number.NEGATIVE_INFINITY;
  private state: WorldStateSnapshot | null = null;
  private readonly pendingAcks = new Map<
    number,
    { resolve: (r: { ok: boolean; errors?: string[]; notes?: string[] }) => void; timer: NodeJS.Timeout }
  >();
  /**
   * M122: 世界の記憶(チャット+出来事)。会話セッションを跨いで世界そのものが履歴を持つ
   * — どの会話が世界チャットを担当しても、observe すれば過去の文脈が見える
   */
  private readonly chatLog: { from: 'user' | 'agent' | 'world' | 'hinata'; text: string; ts?: string }[] = [];
  private chatHandler: ((text: string) => void) | null = null;
  /**
   * M115-4: 世界の正本。spawn/remove の全パラメータを id 単位で保持し、ページは
   * この写像(ビュー)にすぎない。ページ再入場時は hello を受けてここから復元する。
   * 挿入順を保つ Map = 建てられた順に復元される
   */
  private readonly objects = new Map<string, WorldCommand>();
  /** M120: 世界に置かれたアプリ(社)の正本 */
  private readonly apps = new Map<string, WorldApp>();
  private persistPath: string | null = null;
  /** M194b: 物id → 五感プロファイル(世界の真実。建築者が定義する) */
  private senseProfiles = new Map<string, Record<string, { v: number; desc: string }>>();
  /** M116-B: エージェントが世界を「見る」ための観戦URL(ipc.tsがポートを知っているので注入) */
  private spectateUrl: string | null = null;
  /** M120: 世界アプリの実体ディレクトリ(userData/world-apps)。howToAppsの案内に使う */
  private worldAppsDir: string | null = null;
  /** M125: 配信モードの機械ガード。ON中は削除系・録画コマンドを実行前に拒否する */
  private liveGuard = false;

  setLiveGuard(on: boolean): void {
    this.liveGuard = on;
  }

  isLiveGuardOn(): boolean {
    return this.liveGuard;
  }

  setSpectateUrl(url: string): void {
    this.spectateUrl = url;
  }

  setWorldAppsDir(dir: string): void {
    this.worldAppsDir = dir;
  }

  constructor(
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
    private readonly ackTimeoutMs: number = ACK_TIMEOUT_MS,
  ) {}

  /** 永続化先を設定し、あればディスクから正本を読み戻す(起動時に ipc.ts が呼ぶ) */
  loadPersisted(path: string): void {
    this.persistPath = path;
    try {
      // 実行時 import を避けるため require 相当は使わず、node:fs は静的 import(下)を使う
      const raw = readFileSync(path, 'utf8');
      const data = JSON.parse(raw) as {
        objects?: WorldCommand[];
        apps?: WorldApp[];
        log?: { from: 'user' | 'agent' | 'world' | 'hinata'; text: string; ts?: string }[];
        senses?: Record<string, Record<string, { v: number; desc: string }>>;
      };
      for (const c of data.objects ?? []) {
        if (c.type === 'spawn' && typeof c.id === 'string') this.objects.set(c.id, c);
      }
      // M194b: 物の五感プロファイル(世界の真実)も正本の一部
      for (const [id, prof] of Object.entries(data.senses ?? {})) this.senseProfiles.set(id, prof);
      for (const a of data.apps ?? []) {
        if (typeof a.id === 'string') this.apps.set(a.id, a);
      }
      // M122: 世界の記憶を読み戻す(再起動しても会話の文脈が続く)
      this.chatLog.push(...(data.log ?? []).slice(-WORLD_LOG_MAX));
    } catch {
      // 初回起動(ファイルなし)や破損は空の世界から始める。破損は上書き保存で自然回復する
    }
  }

  private persist(): void {
    if (this.persistPath === null) return;
    try {
      writeFileSync(
        this.persistPath,
        JSON.stringify(
          {
            objects: [...this.objects.values()],
            apps: [...this.apps.values()],
            log: this.chatLog,
            senses: Object.fromEntries(this.senseProfiles),
          },
          null,
          1,
        ),
      );
    } catch (err) {
      console.error('[world] 正本の保存に失敗:', err);
    }
  }

  /** act で通ったコマンドを正本へ反映する(検証済み前提の楽観適用) */
  private applyToCanon(cmds: WorldCommand[]): void {
    let changed = false;
    for (const c of cmds) {
      if (c.type === 'spawn') {
        const id = c.id ?? `auto_${this.seq}_${this.objects.size}`;
        this.objects.set(id, { ...c, id });
        changed = true;
      } else if (c.type === 'remove' && typeof c.id === 'string') {
        if (this.objects.delete(c.id)) changed = true;
      } else if (c.type === 'app_add' && c.app !== undefined) {
        this.apps.set(c.app.id, c.app);
        this.pushChat('world', '📥 アプリ設置: ' + c.app.name + ' (' + c.app.id + ')');
        changed = true;
      } else if (c.type === 'app_move' && typeof c.appId === 'string') {
        const app = this.apps.get(c.appId);
        if (app !== undefined) {
          if (typeof c.x === 'number') app.x = c.x;
          if (typeof c.z === 'number') app.z = c.z;
          if (typeof c.ry === 'number') app.ry = c.ry;
          changed = true;
        }
      } else if (c.type === 'app_remove' && typeof c.appId === 'string') {
        if (this.apps.delete(c.appId)) { this.pushChat('world', '🗑 アプリ撤去: ' + c.appId); changed = true; }
      } else if (c.type === 'sense_profile' && typeof c.id === 'string' && c.senses !== undefined) {
        // M194b: 五感プロファイル=世界の真実。建築者(テラ)が定義し、住人はこれを通して物を感じる
        const clean: Record<string, { v: number; desc: string }> = {};
        for (const k of ['sight', 'sound', 'touch', 'smell', 'taste']) {
          const e = c.senses[k];
          if (e === undefined) continue;
          const v = Number(e.v);
          clean[k] = { v: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0, desc: String(e.desc ?? '').slice(0, 60) };
        }
        this.senseProfiles.set(c.id, clean);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** M120: 登録済みアプリ一覧(world_observe と RemoteServer 静的配信の妥当性チェックに使う) */
  listApps(): WorldApp[] {
    return [...this.apps.values()];
  }

  /** M120: ページからの app_move(人間のドラッグ)を正本に反映する。M127: y/ryも受ける */
  moveApp(appId: string, x: number, z: number, y?: number, ry?: number, locked?: boolean): boolean {
    const app = this.apps.get(appId);
    if (app === undefined) return false;
    app.x = x;
    app.z = z;
    if (typeof y === 'number') app.y = y;
    if (typeof ry === 'number') app.ry = ry;
    if (typeof locked === 'boolean') app.locked = locked;
    this.persist();
    return true;
  }

  /** M127: いまユーザーの画面で開いているアプリ(ページからの app_view で更新) */
  private openAppId: string | null = null;

  /** M129b: アプリの最新publish状態(メモリのみ・再起動で消える) */
  private readonly appStatesLive = new Map<string, unknown>();

  /** M127: システム側からの世界への告知(承認待ち等)。アバターの吹き出し+世界ログに残す */
  notify(text: string): void {
    this.pushChat('world', text);
    if (this.isConnected()) {
      this.bus.publish('world:event', { seq: ++this.seq, cmds: [{ type: 'say', text }], quiet: true });
    }
  }

  /** 世界内チャット到着時の処理(ipc.ts が service.chatSend へ橋渡しする)を注入 */
  setChatHandler(handler: (text: string) => void): void {
    this.chatHandler = handler;
  }

  isConnected(): boolean {
    return this.now() - this.lastSeenMs < CONNECT_TIMEOUT_MS;
  }

  /** RemoteServer から呼ばれる。世界ページからの全イベントの入口 */
  onPageEvent(ev: WorldPageEvent): { ok: boolean } {
    this.lastSeenMs = this.now();
    switch (ev.kind) {
      case 'hello': {
        if (ev.state) this.storeState(ev.state);
        // M128: 新しいページでは何も開いていない=「開いてるアプリ」の記録を巻き戻す
        this.openAppId = null;
        // M115-4: 再入場したページへ世界の正本を復元(quiet=効果音・カメラ演出なし)
        const restore = this.restorePayload();
        if (restore !== null) this.bus.publish('world:event', restore);
        return { ok: true };
      }
      case 'state':
        if (ev.state) this.storeState(ev.state);
        return { ok: true };
      case 'chat': {
        if (typeof ev.text !== 'string' || ev.text.trim() === '') return { ok: false };
        this.pushChat('user', ev.text);
        // b案P2: 振り分け — 雑談は生命体(world:chat経由・観戦SSEで知覚)、作業指示は思考層へ。
        // 両方に届けると二重返事になるため排他(2026-08-09 未明の実測フィードバック)
        if (routeWorldChat(ev.text) === 'hinata') {
          this.bus.publish('world:chat', { from: 'user', text: ev.text });
        } else if (this.chatHandler !== null) {
          this.chatHandler(ev.text);
        } else {
          // M173: 分離世界(world-server)にはテラ本体がいない=SSEブリッジ経由でアプリへ届ける
          this.bus.publish('world:agent-chat', { text: ev.text });
        }
        return { ok: true };
      }
      case 'app_moved': {
        // M120: 人間がドラッグでアプリを動かした(ページ→正本)
        if (typeof ev.appId !== 'string' || typeof ev.x !== 'number' || typeof ev.z !== 'number') return { ok: false };
        return { ok: this.moveApp(ev.appId, ev.x, ev.z, ev.y, ev.ry, ev.locked) };
      }
      case 'obj_moved': {
        // M169: 建築物のユーザー配置調整(ページ→正本のspawn定義へ。復元でも位置が続く)
        if (typeof ev.objId !== 'string') return { ok: false };
        const def = this.objects.get(ev.objId);
        if (def === undefined) return { ok: false };
        if (typeof ev.x === 'number') def.x = ev.x;
        if (typeof ev.z === 'number') def.z = ev.z;
        if (typeof ev.uy === 'number') def.uy = ev.uy;
        if (typeof ev.ury === 'number') def.ury = ev.ury;
        if (typeof ev.locked === 'boolean') def.locked = ev.locked;
        this.persist();
        // 他ページへは再spawnせず差分同期(まばたきさせない)
        this.bus.publish('world:event', {
          seq: ++this.seq,
          cmds: [{ type: 'obj_sync', id: ev.objId, x: def.x, z: def.z, uy: def.uy, ury: def.ury, locked: def.locked }],
          quiet: true,
        });
        return { ok: true };
      }
      case 'app_state': {
        // M129b: アプリのpublish状態はmainを経由して全ページへ配る。
        // スクショ用の観戦ページは毎回新規=ページ内だけの保持では「生きた社」が映らない。
        // M132: state未指定=アプリ終了によるクリア(全ページの社が初期表示へ戻る)
        if (typeof ev.appId !== 'string') return { ok: false };
        if (ev.state === undefined) this.appStatesLive.delete(ev.appId);
        else this.appStatesLive.set(ev.appId, ev.state);
        this.bus.publish('world:event', {
          seq: ++this.seq,
          cmds: [{ type: 'app_state', appId: ev.appId, appState: ev.state }],
          quiet: true,
        });
        return { ok: true };
      }
      case 'app_view': {
        // M127: 表示中アプリの追跡。ユーザーのタップ起動は世界ログにも残す=エージェントの文脈になる
        this.openAppId = typeof ev.appId === 'string' ? ev.appId : null;
        if (ev.byUser === true && this.openAppId !== null) {
          const app = this.apps.get(this.openAppId);
          this.pushChat('world', `👆 ユーザーがアプリ「${app?.name ?? this.openAppId}」を開いた`);
        }
        return { ok: true };
      }
      case 'ack': {
        if (ev.state) this.state = ev.state;
        const pending = this.pendingAcks.get(ev.seq);
        if (pending) {
          this.pendingAcks.delete(ev.seq);
          clearTimeout(pending.timer);
          pending.resolve({ ok: ev.ok, errors: ev.errors, notes: ev.notes });
        }
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  }

  /** M115-4/5: 世界の正本を復元バッチとして払い出す(hello時と観戦モード初期表示に使う) */
  restorePayload(): WorldPushPayload | null {
    const cmds: WorldCommand[] = [...this.objects.values()];
    for (const app of this.apps.values()) cmds.push({ type: 'app_add', app });
    // M129b: 生きた社の最新stateも復元(新規ページ・観戦スクショにも映る)
    for (const [appId, appState] of this.appStatesLive) cmds.push({ type: 'app_state', appId, appState });
    // M128: チャットは世界の記憶=再入場でも直近分を見せる(会話の続きがすぐ分かる)
    if (this.chatLog.length > 0) {
      cmds.push({ type: 'chat_restore', entries: this.chatLog.slice(-12).map(({ from, text }) => ({ from, text })) });
    }
    // M147: アバターの現在地・モーションも復元(新規/再入場ページの「初期位置に棒立ち」対策)。
    // 正確な現在値は実行係が10秒毎に報告する state スナップショットが持っている
    const av = this.state?.avatar;
    if (av !== undefined && typeof av.x === 'number' && typeof av.z === 'number') {
      cmds.push({ type: 'avatar_state', x: av.x, z: av.z, name: av.motion });
    }
    if (cmds.length === 0) return null;
    return { seq: ++this.seq, cmds, quiet: true };
  }

  /** M163: 会話ログの全履歴(話者・時刻付き)。スマホの履歴ページ用 */
  chatHistory(limit = 200): { from: string; text: string; ts?: string }[] {
    return this.chatLog.slice(-limit);
  }

  /** world_observe ツールが返す内容 */
  observe(): {
    connected: boolean;
    state: WorldStateSnapshot | null;
    chat: { from: string; text: string }[];
    apps?: WorldApp[];
    openApp?: string | null;
    howToSee?: string;
    howToApps?: string;
    resident?: string;
    senses?: Record<string, Record<string, { v: number; desc: string }>>;
  } {
    return {
      connected: this.isConnected(),
      state: this.state,
      chat: this.chatLog.slice(-40),
      // M194b: 物の五感プロファイル(世界の真実)。住人の知覚がこれを取り込む
      senses: Object.fromEntries(this.senseProfiles),
      // M154: 人格の混線防止(実測: エージェントが住人の発言を自分の続きと誤認して名乗った)
      resident:
        'この世界にはあなたとは別の住人「ヒナタ」(自律生命体)が住んでいる。chatの from:"hinata" は' +
        '彼女の発言で、あなたの発言ではない。**あなたはヒナタを名乗らない・彼女のふりをしない**。' +
        'あなたはAMA-teras(大工・世話役)として振る舞い、彼女には友達として接すること。' +
        '彼女と話すときは1〜2文で短く・sayは1ターン1回・推測で長く語らない(人間の返事はみんな短い)',
      apps: this.listApps(),
      // M127: 「〇〇してみて」の〇〇は開いているアプリのことが多い。文脈として常に返す
      openApp: this.openAppId,
      ...(this.spectateUrl !== null
        ? {
            howToSee:
              `見た目の確認は screenshot ツールで ${this.spectateUrl} を撮る(waitMs:12000 を指定。読込が重い)。` +
              'カメラは &cam=front(アバター正面) / &cam=pov(アバターの目線) / &cam=overview(俯瞰) / ' +
              '&cam=top(平面図: 真上・x/zのズレ計測) / &cam=side(正面立面図: x/y=高さの計測) / ' +
              '&cam=sidex(側面立面図: z/y) を付けて選ぶ。図面系は1mグリッド+ID札付き。' +
              '実寸は state.objects の w/h/d、高さ方向は bottom(接地なら0)と top(最上端)。' +
              '水平のズレは top で、高さのズレは side/sidex で必ず測ってから直すこと。' +
              '⚠spawn には必ず日本語の label を付けること(例: label:"風車")。この世界に住む生命体' +
              '(ヒナタ)はラベルで物を知覚する — 名前のない物は彼女には「名前の分からない何か」に見える。' +
              'あなたが名付けることが、彼女に世界を見せることになる。' +
              '⚠さらに、新しい物を建てたら必ず world_act の sense_profile でその物の五感プロファイル' +
              '(世界の真実)も定義すること — 彼女はこれを通して物を感じる。書式: ' +
              '{type:"sense_profile", id:"<物のid>", senses:{sight:{v:0〜1,desc:"見た目の特徴を一言"}, ' +
              'sound:{...}, touch:{...ゆれ・動きもここ}, smell:{...}, taste:{...}}}。' +
              'vはその感覚での感じられやすさ(見た目のよい物はsightが高い)。tasteは口にできる物だけ>0',
            howToApps:
              `アプリを世界に置く手順: ①write_file で ${this.worldAppsDir ?? '<userData>/world-apps'}/<id>/index.html に` +
              'Webアプリを書く(単一HTML推奨。操作したいボタン・表示にはidを振ること=後で自分がclick/readしやすい) ' +
              '②world_act app_add で登録。kioskCode(社の3D外観)は必ずアプリの機能が一目で分かる造形にすること' +
              '(電卓なら大きな電卓型、時計なら時計塔など)。名前の看板は不要=見た目で語る。' +
              '⚠kioskCodeが例外を投げると黙って既定の鳥居にフォールバックする — 建て替え後は' +
              '「作った造形そのものが写っている絵」で検証し、鳥居に化けていないか必ず確認すること。' +
              'ユーザーがダブルタップ(またはあなたが app_open)するとオーバーレイで開く。' +
              'openApp フィールドが「ユーザーがいま開いているアプリ」— 「これ」「〇〇してみて」はまずそのアプリを指すと考える。' +
              'app_point(selector)で開いた画面の要素を赤矢印で指せる=「ここを押して」の視覚誘導。' +
              'app_click(selector)/app_type(selector,text)/app_read(selector)で開いたアプリを実際に操作・実演できる' +
              '(例: 電卓のボタンをclick→#dispをreadして答えをsayで報告)。' +
              'app_leave で表示だけ畳む(アプリは裏で生きたまま=入力や状態は保持)。app_open は別アプリへの切替' +
              '(前のアプリも生き続ける)。app_close(appId)で完全終了(状態destroy)。' +
              'app_remove は社ごと世界から撤去(ただしHTMLファイルは残るので app_add で復元できる)。' +
              '生きた社: アプリのJSから amaWorld.publish(state) を呼ぶと(注入済みAPI・引数は任意のJSON)、' +
              '社の kioskCode の userData.tick = (dt, t, state) の第3引数に最新stateが届く。' +
              '電卓の表示を社の3Dに映す等はこれで作る(文字はTHREEの7セグ風造形などで。documentは使えない)。' +
              'アプリが完全終了(app_close/×ボタン)するとstateはクリアされ、tickの第3引数はundefinedに戻る' +
              '=tickは「state===undefinedなら初期表示」を必ず実装すること。' +
              '文字表示は kioskCode の第2引数 helpers.textPanel({w,h,text,...}) を使う' +
              '(返りmeshのuserData.setText(文字)をtickから呼べば黒板・掲示板が作れる)。' +
              '巨大な演出部品(ドーム・空エフェクト等)には userData.noTap = true を付けること=タップ判定から除外される。' +
              'kioskのtickは第4引数で全アプリのstate(Map)を受け取れる=他アプリ連動' +
              '(例: 月アプリのtickが states.get("clock") でアラーム時刻を読む)',
          }
        : {}),
    };
  }

  /**
   * world_act ツールの実体。コマンド列をページへ押し出し、実行結果(ack)を待つ。
   * 未接続なら即座に失敗を返す(エージェントが延々待たないように)
   */
  act(cmds: WorldCommand[]): Promise<{ ok: boolean; detail: string }> {
    if (!this.isConnected()) {
      return Promise.resolve({
        ok: false,
        detail: '世界ページが未接続(world.html が開かれていないか、しばらく応答がない)。ユーザーに世界を開いてもらうこと。',
      });
    }
    // M125(4): 配信モード中は破壊系を機械拒否(プロンプト指示だけに頼らない)
    if (this.liveGuard) {
      const banned = cmds.find((c) => c.type === 'remove' || c.type === 'app_remove' || c.type === 'record');
      if (banned !== undefined) {
        return Promise.resolve({
          ok: false,
          detail: `配信モード中は ${banned.type} は使えない(世界の破壊防止)。建築だけで応えること`,
        });
      }
    }
    for (const c of cmds) {
      if (c.type === 'say' && typeof c.text === 'string') this.pushChat(c.speaker === 'hinata' ? 'hinata' : 'agent', c.text);
    }
    this.applyToCanon(cmds);
    // M194b: sense_profileは正本だけの操作(ページに描くものがない)。ページへは送らない
    const pageCmds = cmds.filter((c) => c.type !== 'sense_profile');
    if (pageCmds.length === 0) {
      return Promise.resolve({ ok: true, detail: `五感プロファイルを記録した(${cmds.length}件)` });
    }
    const seq = ++this.seq;
    const payload: WorldPushPayload = { seq, cmds: pageCmds };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(seq);
        resolve({ ok: false, detail: `世界ページからの応答なし(${this.ackTimeoutMs}ms)。ページが閉じられた可能性がある` });
      }, this.ackTimeoutMs);
      this.pendingAcks.set(seq, {
        resolve: (r) => {
          // M126: app_read の読み取り結果はackのnotesに乗って返る
          const notes = (r.notes ?? []).length > 0 ? ` / ${(r.notes ?? []).join(' / ')}` : '';
          // M193: sayの内容を結果にエコーする。エコーが無いとエージェントが「届いたか不安」で
          // 言い換え再送し、二重返答になる実害があった(テラの発話が毎回2連になる)
          const said = cmds
            .filter((c) => c.type === 'say' && typeof c.text === 'string')
            .map((c) => `「${String(c.text).slice(0, 40)}」`)
            .join('');
          const echo = said !== '' ? ` 発話済み:${said}` : '';
          resolve({ ok: r.ok, detail: r.ok ? `実行完了(${cmds.length}コマンド)${echo}${notes}` : `一部失敗: ${(r.errors ?? []).join(' / ')}${notes}` });
        },
        timer,
      });
      this.bus.publish('world:event', payload);
    });
  }

  /**
   * M147b: 状態スナップショットの取り込み。avatar は実行係だけが報告する設計なので、
   * 報告に無ければ既知の値を保持する(閲覧ページのhello/stateで正本のアバター位置が消えない)
   */
  private storeState(s: WorldStateSnapshot): void {
    const avatar = s.avatar ?? this.state?.avatar;
    this.state = { ...s, ...(avatar !== undefined ? { avatar } : {}) };
  }

  private pushChat(from: 'user' | 'agent' | 'world' | 'hinata', text: string): void {
    this.chatLog.push({ from, text, ts: new Date(this.now()).toISOString() });
    if (this.chatLog.length > WORLD_LOG_MAX) this.chatLog.splice(0, this.chatLog.length - WORLD_LOG_MAX);
    this.persist();
  }

  /**
   * M175(B工事): 訪問者(招待制ゲスト)の発言。
   * - チャットログには guest:名前 で残る(会話ログページで見える)
   * - 表示は弾幕(live_comment)=全ページに流れる
   * - ヒナタは world:chat で知覚する(who=名前。ひとの台帳が名前で生える)
   * テラ(思考層)へは中継しない=訪問者はヒナタの友達であって発注者ではない
   */
  /** M177(配信工事): 表示専用コマンド(弾幕・HUD)をそのまま配る(ack不要・記録不要) */
  publishQuiet(cmds: WorldCommand[]): void {
    this.bus.publish('world:event', { seq: ++this.seq, cmds, quiet: true });
  }

  /** M177: 視聴者や外の声をヒナタの知覚にだけ届ける(表示は呼び出し側の責務) */
  hinataHear(who: string, text: string): void {
    this.pushChat(`guest:${who}` as 'user', text);
    this.bus.publish('world:chat', { from: 'user', text, who });
  }

  /** M176(B v2): 訪問者ゴーストの位置を全ページへ配る(正しいseqで) */
  visitorSync(id: string, name: string, x: number, z: number, stance?: string): void {
    this.bus.publish('world:event', {
      seq: ++this.seq,
      cmds: [{ type: 'visitor_sync', id, name, x, z, stance } as unknown as WorldCommand],
      quiet: true,
    });
  }

  visitorGone(id: string, name: string): void {
    this.bus.publish('world:event', {
      seq: ++this.seq,
      cmds: [{ type: 'visitor_gone', id, name } as WorldCommand],
      quiet: true,
    });
  }

  visitorChat(name: string, text: string): void {
    this.pushChat(`guest:${name}` as 'user', text);
    this.bus.publish('world:event', {
      seq: ++this.seq,
      cmds: [{ type: 'live_comment', author: name, text } as WorldCommand],
      quiet: true,
    });
    this.bus.publish('world:chat', { from: 'user', text, who: name });
  }
}
