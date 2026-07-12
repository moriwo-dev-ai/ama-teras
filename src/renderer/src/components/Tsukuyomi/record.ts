/**
 * M42-5(TUKU-yomi): 耳 — 録音(push-to-talk)。
 *
 * マイクの音声はこの中とローカル whisper だけを通る。**APIには送らない**(鉄則2)。
 * 録音データはメモリ内の Float32 のまま持ち、16kHz mono の WAV にして main へ渡す。
 * ディスクには書かない(main が tmp に書いて、文字起こし直後に消す)。
 */

/** whisper が期待するサンプリングレート */
const TARGET_RATE = 16000;

/** Float32(-1〜1)→ 16bit PCM の WAV(mono) */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

/** 単純な間引きリサンプル(whisper用。音質より軽さ・依存ゼロを優先) */
export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)] ?? 0;
  return out;
}

export class Recorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];

  async start(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return false; // 権限拒否。黙って諦める
    }
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor は非推奨だが、依存ゼロで生サンプルを取れる(AudioWorkletは5bで検討)
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(this.processor);
    this.processor.connect(this.ctx.destination);
    return true;
  }

  /** 録音を止めて WAV を返す。マイクは即解放(ランプを消す) */
  stop(): ArrayBuffer | null {
    const rate = this.ctx?.sampleRate ?? 48000;
    this.processor?.disconnect();
    this.processor = null;
    void this.ctx?.close();
    this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    if (total === 0) return null;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.chunks = []; // 音声はここで捨てる(メモリにも残さない)
    return encodeWav(downsample(merged, rate, TARGET_RATE), TARGET_RATE);
  }
}
