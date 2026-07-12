import { MIC_CONSTRAINTS, initialVad, rms, stepVad, type VadState } from '../../../../shared/tsukuyomiVad';
import { downsample, encodeWav } from './record';

/**
 * M42-5b(TUKU-yomi): 耳 — 常時聴取。
 *
 * マイクを開いたままにするが、**送るのは「人が喋った区間」だけ**(VADで切り出す)。
 * 無音は捨てる。音声は renderer のメモリとローカル whisper だけを通り、**APIには行かない**。
 *
 * 稼働中は必ず「👂 聴取中」が出る(鉄則5)。停止は1クリック。
 * 鉄則10: タイマー/ノードはハンドルを保持し、stop() で必ず解放。stopped で復活を禁止する。
 */

const TARGET_RATE = 16000;
/** 発話区間の前後に付ける余白(語頭が切れないように) */
const PAD_MS = 300;

export interface EarsWatchDeps {
  /** 切り出した発話区間(WAV)。main へ渡して文字起こし → 抽出 → 確認UI */
  onUtterance: (wav: ArrayBuffer) => void;
  nowFn?: () => number;
}

export class EarsWatch {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private stopped = false;
  /** PTT中は一時停止(マイクは開いたままだが、区間を切り出さない) */
  private paused = false;
  private vad: VadState = initialVad();
  /** 発話中に貯めるサンプル(区間が終わったら WAV にして渡し、すぐ捨てる) */
  private buffer: Float32Array[] = [];
  /** 語頭の余白のために、直前の無音も少しだけ持っておく */
  private padding: Float32Array[] = [];
  private rate = 48000;

  constructor(private readonly deps: EarsWatchDeps) {}

  async start(): Promise<boolean> {
    if (this.stopped || this.stream !== null) return this.stream !== null;
    try {
      // audio:true だと AGC が環境音を声の大きさまで持ち上げる(MIC_CONSTRAINTS のコメント参照)
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS } });
    } catch {
      return false; // 権限拒否。黙って諦める
    }
    this.ctx = new AudioContext();
    this.rate = this.ctx.sampleRate;
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => this.onFrame(e.inputBuffer.getChannelData(0));
    source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    return true;
  }

  /** 使い捨て。マイクは即解放(ランプを消す)。貯めた音声も捨てる */
  stop(): void {
    this.stopped = true;
    this.processor?.disconnect();
    this.processor = null;
    void this.ctx?.close();
    this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.buffer = [];
    this.padding = [];
    this.vad = initialVad();
  }

  /**
   * 押して話す(PTT)の最中は常時聴取を黙らせる。
   * 同じ声を2経路で拾うと、1回の発話から候補が2つできる(実機で起きた)。
   * クラウド文字起こしなら課金も2回になる
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.buffer = [];
      this.padding = [];
      this.vad = initialVad();
    }
  }

  private onFrame(frame: Float32Array): void {
    if (this.stopped || this.paused) return;
    const copy = new Float32Array(frame); // 参照を持ち越さない(次のコールバックで上書きされる)
    const nowMs = this.deps.nowFn?.() ?? performance.now();
    const level = rms(copy);
    const { state, event } = stepVad(this.vad, level, nowMs);
    this.vad = state;

    if (state.speaking) {
      this.buffer.push(copy);
    } else {
      // 語頭の余白用に直近だけ保持(それ以上は捨てる=聞いた音を溜め込まない)
      const padFrames = Math.ceil((PAD_MS / 1000) * (this.rate / copy.length));
      this.padding.push(copy);
      if (this.padding.length > padFrames) this.padding.shift();
    }

    if (event === 'start') {
      this.buffer = [...this.padding, copy]; // 語頭の余白を先頭に付ける
      this.padding = [];
      return;
    }
    if (event === 'discard') {
      this.buffer = []; // 咳・物音は捨てる(文字起こししない)
      return;
    }
    if (event === 'end') {
      const wav = this.flush();
      this.buffer = [];
      if (wav !== null) this.deps.onUtterance(wav);
    }
  }

  /** 貯めた発話区間を 16kHz mono WAV にする。**渡したらメモリからは消える** */
  private flush(): ArrayBuffer | null {
    const total = this.buffer.reduce((n, c) => n + c.length, 0);
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of this.buffer) {
      merged.set(c, offset);
      offset += c.length;
    }
    return encodeWav(downsample(merged, this.rate, TARGET_RATE), TARGET_RATE);
  }
}
