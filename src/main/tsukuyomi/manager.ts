import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, ChoEntry, RunInfo, TsukuyomiConfig, TsukuyomiEvent, TsukuyomiStatus } from '../../shared/types';
import { TSUKUYOMI_DEFAULTS } from '../config';
import type { LLMProvider } from '../providers/types';
import {
  canInterrupt,
  canSendFrame,
  emptyState,
  framesLeftThisHour,
  framesLeftToday,
  interruptsLeft,
  isQuietHour,
  resetIfNewDay,
  spend,
  spendFrame,
  type TsukuyomiState,
} from './budget';
import { extractCommitments, type ExtractedItem } from './extractor';
import { understandScene } from './sceneUnderstanding';
import { finishedRuns, runLabel, speechFor } from './speaker';
import { TsukiNoCho } from './tsukiNoCho';
import { transcribe, whisperPaths, whisperReady, type WhisperRunner } from './transcriber';
import { foregroundWindow, windowText, type ShellRunner } from './windowObserver';

/**
 * M42(TUKU-yomi): 月読モードのライフサイクル。
 *
 * electron 非依存(OperationsManager と同じ流儀。deps 注入・テスト可能)。
 * 鉄則10: タイマーはハンドルを保持し、stop() で必ず clearTimeout/clearInterval。
 * stopped フラグで復活を禁止し、**停止済みインスタンスは state.json を書かない**
 * (M41の幽霊スケジューラ事件の再発防止)。
 */

export interface TsukuyomiManagerDeps {
  /** userData のパス(ここに tsukuyomi/ を作る) */
  userDataDir: string;
  getConfig: () => AppConfig;
  /** オーナー鍵の有無(ipc.ts が existsSync を注入。テストは偽述語) */
  hasOwnerKey: () => boolean;
  /** renderer への通知(remote-ui へは中継しない) */
  emit: (event: TsukuyomiEvent) => void;
  /** M42-4: 映像理解に使うプロバイダ(vision対応。未注入=理解しない) */
  visionProvider?: () => LLMProvider | null;
  /** M42-4: トークン消費を usage 集計へ */
  onVisionUsage?: (inputTokens: number, outputTokens: number) => void;
  /** M42-5: whisper の実行(テストでは偽実装。音声はAPIに出ない) */
  whisperRunner?: WhisperRunner;
  /** M42-6: PC窓観測の spawn(テストでは偽実装。スクリーンショットは撮らない) */
  shellRunner?: ShellRunner;
  nowFn?: () => Date;
}

/** 忘却(observation の7日削除)の実行間隔 */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export class TsukuyomiManager {
  private readonly dir: string;
  private readonly cho: TsukiNoCho;
  private state: TsukuyomiState;
  private pruneTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** M42-2: 発話ソース。前回のラン一覧・承認待ち件数(差分でしか喋らない) */
  private lastRuns: RunInfo[] = [];
  private lastApprovalCount = 0;
  /** M42-3: 離席中か。留守中の出来事は溜めて、戻った時にまとめて伝える */
  private away = false;
  private whileAway: string[] = [];
  /** M42-6: 直前に観測したウィンドウ(同じ行で帳を埋めないため) */
  private lastWindowKey: string | null = null;
  /** M42-5b: whisper の直列化。常時聴取で発話が重なっても多重起動させない */
  private transcribeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: TsukuyomiManagerDeps) {
    this.dir = join(deps.userDataDir, 'tsukuyomi');
    this.cho = new TsukiNoCho(join(this.dir, 'tsuki-no-cho.jsonl'), () => this.now());
    this.state = this.loadState();
  }

  private now(): Date {
    return this.deps.nowFn?.() ?? new Date();
  }

  private cfg(): TsukuyomiConfig {
    return this.deps.getConfig().tsukuyomi ?? { enabled: false };
  }

  /** 鍵が無い/モードOFFなら何もしない(帳の読み書きも含めて) */
  private active(): boolean {
    return this.deps.hasOwnerKey() && this.cfg().enabled;
  }

  // ---- 状態(割り込み予算・フレーム送信数)----

  private get statePath(): string {
    return join(this.dir, 'state.json');
  }

  private loadState(): TsukuyomiState {
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<TsukuyomiState>;
      return resetIfNewDay(
        {
          day: typeof raw.day === 'string' ? raw.day : '',
          interruptsSpent: typeof raw.interruptsSpent === 'number' ? raw.interruptsSpent : 0,
          framesSpentToday: typeof raw.framesSpentToday === 'number' ? raw.framesSpentToday : 0,
          frameTimesThisHour: Array.isArray(raw.frameTimesThisHour)
            ? raw.frameTimesThisHour.filter((t): t is string => typeof t === 'string')
            : [],
        },
        this.now(),
      );
    } catch {
      return emptyState(this.now());
    }
  }

  private saveState(): void {
    if (this.stopped) return; // 鉄則10: 停止済みインスタンスは書き込まない
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 1), 'utf8');
  }

  // ---- ライフサイクル ----

  start(): void {
    if (this.stopped || this.pruneTimer !== null) return;
    if (!this.active()) return;
    this.cho.prune();
    this.pruneTimer = setInterval(() => {
      if (this.stopped) return;
      this.cho.prune();
      this.emitStatus();
    }, PRUNE_INTERVAL_MS);
    this.emitStatus();
  }

  /** 使い捨て。stop() 後に start() しても復活しない(幽霊インスタンスを作らない) */
  stop(): void {
    this.stopped = true;
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  // ---- 月の帳 ----

  list(): ChoEntry[] {
    if (!this.active()) return [];
    return this.cho.list();
  }

  add(entry: Omit<ChoEntry, 'id' | 'ts'>): ChoEntry | null {
    if (!this.active()) return null;
    const created = this.cho.add(entry);
    this.deps.emit({ type: 'cho-changed' });
    return created;
  }

  setDone(id: string, done: boolean): ChoEntry | null {
    if (!this.active()) return null;
    const updated = this.cho.setDone(id, done);
    if (updated !== null) this.deps.emit({ type: 'cho-changed' });
    return updated;
  }

  // ---- 割り込み(発話)----

  /**
   * 自発的な発話。予算切れ・静音時間なら**黙る**(false を返す)。
   * ユーザーが押したボタンによる発話はこれを通さない(予算対象外・鉄則3)
   */
  trySpeak(text: string): boolean {
    if (!this.active() || this.cfg().voiceOutput !== true) return false;
    const now = this.now();
    this.state = resetIfNewDay(this.state, now);
    if (!canInterrupt(this.state, this.cfg(), now)) return false;
    this.state = spend(this.state, now);
    this.saveState();
    this.deps.emit({ type: 'speak', text });
    this.emitStatus();
    return true;
  }

  /** ユーザー起点の発話(「試しに喋る」等)。予算を消費しない */
  speakWithoutBudget(text: string): boolean {
    if (!this.active() || this.cfg().voiceOutput !== true) return false;
    this.deps.emit({ type: 'speak', text });
    return true;
  }

  // ---- M42-2: 発話ソース(実行完了・承認待ち)----

  /**
   * ラン一覧の変化から「終わったよ」を拾う。開始・進行では喋らない(うるさいので)。
   * 予算切れ・静音時間なら黙る
   */
  onRunsChanged(runs: RunInfo[]): void {
    const finished = finishedRuns(this.lastRuns, runs);
    this.lastRuns = runs;
    if (finished.length === 0) return;
    // 複数同時に終わっても声かけは1回(まとめて言う)
    const first = finished[0];
    if (first === undefined) return;
    // M42-3: 留守中に終わったものは溜めておき、戻ってきた時にまとめて伝える
    // (居ないところで喋っても意味がないし、予算の無駄)
    if (this.away) {
      for (const r of finished) this.whileAway.push(`${runLabel(r) || '作業'}が終わってた`);
      return;
    }
    const text = speechFor({ kind: 'runs-finished', label: runLabel(first) });
    if (text !== null) this.trySpeak(text);
  }

  /** 承認待ちがたまったら1回だけ知らせる(同じ件数で二度言わない) */
  onApprovalWaiting(count: number): void {
    if (count === this.lastApprovalCount) return;
    this.lastApprovalCount = count;
    const text = speechFor({ kind: 'approval-waiting', count });
    if (text !== null) this.trySpeak(text);
  }

  /**
   * M42-3: 在席イベント(renderer のカメラ監視から。**映像は来ない・一文だけ**)。
   * 離席→戻りで「おかえり。留守中に〜」。留守中に何も起きていなければ「おかえり」だけ
   */
  onPresence(event: 'away' | 'returned', text: string): void {
    if (!this.active() || this.cfg().camera !== true) return;
    this.add({ kind: 'observation', text, source: 'camera' });
    if (event === 'away') {
      this.away = true;
      this.whileAway = [];
      return;
    }
    this.away = false;
    const spoken = speechFor({ kind: 'welcome-back', whileAway: this.whileAway });
    this.whileAway = [];
    if (spoken !== null) this.trySpeak(spoken);
  }

  // ---- 映像理解のフレーム送信上限 ----

  canSendFrame(): boolean {
    if (!this.active() || this.cfg().cameraUnderstanding !== true) return false;
    return canSendFrame(this.state, this.cfg(), this.now());
  }

  spendFrame(): void {
    this.state = spendFrame(this.state, this.now());
    this.saveState();
    this.emitStatus();
  }

  /**
   * M42-4: 選別された1枚(JPEG base64)から状況の一文を得て帳に残す。
   *
   * **上限に達していたら送らない**(理解を止めるだけで、在席検知は続く・鉄則11)。
   * フレームは保存しない(メモリ→API→破棄)。返り値は帳に入れた一文(入れなければ null)
   */
  async understandFrame(jpegBase64: string): Promise<string | null> {
    if (!this.canSendFrame()) return null;
    const provider = this.deps.visionProvider?.();
    if (provider === undefined || provider === null) return null;

    // 上限は「送る前」に消費する(失敗しても枠は使ったものとして数える=暴走しない)
    this.spendFrame();
    try {
      const { text } = await understandScene(jpegBase64, {
        provider,
        onUsage: (input, output) => this.deps.onVisionUsage?.(input, output),
      });
      if (text === null) return null;
      this.add({ kind: 'observation', text, source: 'camera' });
      return text;
    } catch {
      return null; // API不達・拒否は静かに諦める(月は騒がない)
    }
  }

  // ---- M42-5: 耳(ローカル文字起こし → 抽出 → 確認UI)----

  /** whisper が配置されているか(未配置なら UI に「モデル未配置」を出す) */
  whisperReady(): boolean {
    return whisperReady(whisperPaths(this.deps.userDataDir));
  }

  /**
   * 録音(WAV)→ **ローカル** whisper で文字起こし → 抽出 → **候補を返すだけ**。
   *
   * 音声はAPIに送らない(鉄則2)。一時WAVは文字起こし直後に削除される。
   * 生の文字起こしもここで捨てる — 返すのは抽出結果だけで、帳に書くのは人間の承認後
   */
  async transcribeAndExtract(wav: Buffer): Promise<{ items: ExtractedItem[]; error?: string }> {
    if (!this.active() || this.cfg().ears !== true) return { items: [], error: '耳がOFF' };
    const paths = whisperPaths(this.deps.userDataDir);
    if (!whisperReady(paths)) return { items: [], error: 'whisper が未配置(モデル未配置)' };

    let transcript: string;
    try {
      // 常時聴取では発話が重なる。whisper を多重起動すると CPU を食い潰して全部遅くなるので、
      // **必ず1件ずつ順番に**処理する(実機で1回20秒級かかるため、これは効く)
      transcript = await this.enqueueTranscribe(() =>
        transcribe(wav, paths, {
          ...(this.deps.whisperRunner !== undefined ? { runner: this.deps.whisperRunner } : {}),
        }),
      );
    } catch (err) {
      return { items: [], error: err instanceof Error ? err.message : String(err) };
    }
    if (transcript.trim() === '') return { items: [] };

    const provider = this.deps.visionProvider?.();
    if (provider === undefined || provider === null) return { items: [], error: 'APIキーが未設定' };
    try {
      const items = await extractCommitments(transcript, {
        provider,
        onUsage: (input, output) => this.deps.onVisionUsage?.(input, output),
      });
      // 生の文字起こしはここで捨てる(帳にも返り値にも残さない)
      return { items };
    } catch (err) {
      return { items: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---- M42-6: PC窓観測(神々の時計から呼ばれる)----

  /** 神の投入条件。月読ONかつ pcObserver ON の時だけ神が生える(鍵なし機体では生えない) */
  pcObserverEnabled(): boolean {
    return this.active() && this.cfg().pcObserver === true;
  }

  /**
   * アクティブウィンドウの**タイトルとプロセス名だけ**を帳へ(スクリーンショットは撮らない)。
   * 同じウィンドウが続いている間は書かない(同じ行で帳を埋めない)。
   * ついでに忘却(observation の7日削除)もここで回す
   */
  async observeWindow(): Promise<string | null> {
    if (!this.pcObserverEnabled()) return null;
    const w = await foregroundWindow(this.deps.shellRunner);
    if (w === null) return null;

    const key = `${w.process}\t${w.title}`;
    if (key === this.lastWindowKey) {
      this.cho.prune(); // 変化が無くても忘却は進める
      return null;
    }
    this.lastWindowKey = key;

    const text = windowText(w, this.now());
    this.add({ kind: 'observation', text, source: 'pc' });
    this.cho.prune();
    return text;
  }

  /** whisper を1件ずつ順番に流す(前の文字起こしが終わるまで次を始めない) */
  private enqueueTranscribe(task: () => Promise<string>): Promise<string> {
    const next = this.transcribeQueue.then(task, task);
    // 失敗しても列は詰まらせない(次の発話は普通に処理する)
    this.transcribeQueue = next.catch(() => undefined);
    return next;
  }

  // ---- 現況 ----

  status(): TsukuyomiStatus {
    const cfg = this.cfg();
    const now = this.now();
    const ownerKeyPresent = this.deps.hasOwnerKey();
    const enabled = ownerKeyPresent && cfg.enabled;
    return {
      ownerKeyPresent,
      enabled,
      voiceOutput: enabled && cfg.voiceOutput === true,
      camera: enabled && cfg.camera === true,
      cameraUnderstanding: enabled && cfg.cameraUnderstanding === true,
      ears: enabled && cfg.ears === true,
      pcObserver: enabled && cfg.pcObserver === true,
      interruptsLeft: interruptsLeft(this.state, cfg, now),
      framesLeftThisHour: framesLeftThisHour(this.state, cfg, now),
      framesLeftToday: framesLeftToday(this.state, cfg, now),
      quiet: isQuietHour(now, cfg),
    };
  }

  private emitStatus(): void {
    this.deps.emit({ type: 'status', status: this.status() });
  }

  /** 設定が変わった時に ipc.ts から呼ぶ(ONで開始・OFFで停止しない=stopは使い捨てのため再生成) */
  onConfigChanged(): void {
    if (this.stopped) return;
    if (this.active() && this.pruneTimer === null) this.start();
    this.emitStatus();
  }

  /** 既定値(UIが表示に使う) */
  static defaults(): typeof TSUKUYOMI_DEFAULTS {
    return TSUKUYOMI_DEFAULTS;
  }
}
