import { frameDiff, initialPresence, presenceText, stepPresence, type PresenceState } from '../../../../shared/tsukuyomi';

/**
 * M42-3(TUKU-yomi): 目① — カメラ常時+在席検知。
 *
 * **APIには何も送らない**(送るのは Stage 4 の映像理解だけ、しかも選別した静止画のみ)。
 * フレームはメモリ内で縮小 → グレースケール化 → 前フレームとの差分を取るだけで、
 * 映像も静止画も**ディスクに書かない**。カメラを止めればストリームは即解放される。
 */

/** 何秒おきにフレームを見るか(CPUを食わない間隔。在席の粒度としては十分) */
const SAMPLE_INTERVAL_MS = 3000;
/** 差分計算のための縮小サイズ(小さいほど軽い。人の輪郭が分かる必要はない) */
const SAMPLE_W = 32;
const SAMPLE_H = 24;

/** M42-4: 映像理解に送るJPEGの幅(縮小して送る。顔の判別に足る解像度は要らない) */
const UNDERSTAND_W = 640;
const UNDERSTAND_H = 480;
/** M42-4: 定期理解の間隔(既定10分)。これとシーン変化の2つだけがトリガ */
const UNDERSTAND_INTERVAL_MS = 10 * 60 * 1000;
/** M42-4: この差分を超えたら「場面が変わった」= 理解の候補 */
const SCENE_CHANGE_THRESHOLD = 0.08;

export interface CameraWatchDeps {
  /** 在席状態が変わった時に呼ばれる(帳に書くのは main 側) */
  onPresenceEvent: (event: 'away' | 'returned', text: string) => void;
  /**
   * M42-4: 映像理解へ送る1枚(JPEG base64)。**選別された1枚だけ**がここを通る。
   * 未注入なら理解しない(= APIには何も出ない)
   */
  onFrameForUnderstanding?: (jpegBase64: string) => void;
  nowFn?: () => Date;
}

export class CameraWatch {
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private timer: number | null = null;
  private stopped = false;
  private prev: Uint8ClampedArray = new Uint8ClampedArray();
  private presence: PresenceState = initialPresence();
  /** M42-4: 起動直後の1枚目を「場面変化」と誤認しないため */
  private prevWasInitialized = false;
  private lastUnderstoodAt = 0;

  constructor(private readonly deps: CameraWatchDeps) {}

  running(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<boolean> {
    if (this.stopped || this.stream !== null) return this.stream !== null;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    } catch {
      return false; // 権限拒否・カメラ無し。黙って諦める(月は騒がない)
    }
    const video = document.createElement('video');
    video.srcObject = this.stream;
    video.muted = true;
    await video.play().catch(() => {});
    this.video = video;

    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    this.canvas = canvas;

    this.timer = window.setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    return true;
  }

  /** 使い捨て。stop() 後は start() しても復活しない(鉄則10と同じ思想) */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop()); // カメラのランプを確実に消す
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.prev = new Uint8ClampedArray();
  }

  private sample(): void {
    if (this.stopped || this.video === null || this.canvas === null) return;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return;
    ctx.drawImage(this.video, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);

    // グレースケール(輝度)だけを取る。色も顔も見ない
    const gray = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H);
    for (let i = 0; i < gray.length; i++) {
      const r = data[i * 4] ?? 0;
      const g = data[i * 4 + 1] ?? 0;
      const b = data[i * 4 + 2] ?? 0;
      gray[i] = (r * 299 + g * 587 + b * 114) / 1000;
    }

    const diff = frameDiff(this.prev, gray);
    this.prev = gray;

    const { state, event } = stepPresence(this.presence, diff);
    this.presence = state;
    if (event !== null) {
      const now = this.deps.nowFn?.() ?? new Date();
      this.deps.onPresenceEvent(event, presenceText(event, now));
    }

    // M42-4: 映像理解のトリガは2つだけ — (a) 場面が大きく変わった (b) 定期(10分)。
    // 上限(1時間6枚・1日50枚)は main 側が見るので、ここでは送るだけ(超過なら null が返る)
    if (this.deps.onFrameForUnderstanding === undefined) return;
    const nowMs = (this.deps.nowFn?.() ?? new Date()).getTime();
    const sceneChanged = diff > SCENE_CHANGE_THRESHOLD && this.prevWasInitialized;
    const periodic = nowMs - this.lastUnderstoodAt >= UNDERSTAND_INTERVAL_MS;
    this.prevWasInitialized = true;
    if (!sceneChanged && !periodic) return;
    // 離席中(誰もいない)の理解はしない。無人の机を毎回説明させても意味がない
    if (this.presence.presence === 'away') return;

    this.lastUnderstoodAt = nowMs;
    const jpeg = this.captureJpeg();
    if (jpeg !== null) this.deps.onFrameForUnderstanding(jpeg);
  }

  /**
   * M42-4: 送信用の1枚(JPEG base64)。**この1枚だけがAPIへ行く**。
   * ディスクには書かない(メモリ→IPC→API→破棄)
   */
  private captureJpeg(): string | null {
    if (this.video === null) return null;
    const canvas = document.createElement('canvas');
    canvas.width = UNDERSTAND_W;
    canvas.height = UNDERSTAND_H;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(this.video, 0, 0, UNDERSTAND_W, UNDERSTAND_H);
    // dataURL の "data:image/jpeg;base64," を落として base64 本体だけを渡す
    return canvas.toDataURL('image/jpeg', 0.7).split(',')[1] ?? null;
  }
}
