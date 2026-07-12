import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, ChoEntry, TsukuyomiConfig, TsukuyomiEvent, TsukuyomiStatus } from '../../shared/types';
import { TSUKUYOMI_DEFAULTS } from '../config';
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
import { TsukiNoCho } from './tsukiNoCho';

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
