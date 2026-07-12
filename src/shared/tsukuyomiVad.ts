/**
 * M42-5b(TUKU-yomi): 耳 — 常時聴取のための簡易VAD(発話区間の検出)。
 *
 * 常時マイクを開いても、**送るのは「人が喋った区間」だけ**。無音は捨てる。
 * 判定は音量(RMS)としきい値だけ — 話者識別も内容判定もここではしない(純関数)。
 *
 * 音声は renderer のメモリとローカル whisper だけを通る(APIには行かない・鉄則2)。
 */

/**
 * 常時聴取で開くマイクの条件。
 *
 * **autoGainControl を切るのが肝**。既定(`audio: true`)だと Chrome は AGC を有効にし、
 * 静かな部屋ほどゲインを上げて環境音を「声の大きさ」まで持ち上げてしまう。
 * 実機で測ったら AGC有りは環境音の21%が下のしきい値を超え(p90=0.033)、
 * 20秒に1回 whisper が回り続けた。AGCを切ると同じ部屋で 0.0%(p99=0.016)。
 * 音量を素直に測れないと、しきい値をいくら調整しても意味がない
 */
export const MIC_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: false,
} as const;

/** これを超えたら「声がある」(0〜1。マイクの生RMS) */
export const SPEECH_RMS_THRESHOLD = 0.02;

/** 無音がこの長さ続いたら発話区間の終わり */
export const SILENCE_TO_END_MS = 900;

/** これより短い区間は捨てる(咳・物音・相槌の切れ端) */
export const MIN_SPEECH_MS = 700;

/** これを超えたら強制的に区切る(長い会話を1本の巨大WAVにしない) */
export const MAX_SPEECH_MS = 30_000;

export interface VadState {
  speaking: boolean;
  /** 発話開始時刻(ms) */
  startedAt: number;
  /** 直近で声を検出した時刻(ms) */
  lastVoiceAt: number;
}

export function initialVad(): VadState {
  return { speaking: false, startedAt: 0, lastVoiceAt: 0 };
}

/** 音量(RMS)。0〜1 */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * 1フレーム分進める。
 * event: 'start' = 発話が始まった / 'end' = 発話が終わった(この区間を文字起こしへ)/
 *        'discard' = 短すぎたので捨てる
 */
export function stepVad(
  state: VadState,
  level: number,
  nowMs: number,
): { state: VadState; event: 'start' | 'end' | 'discard' | null } {
  const voice = level > SPEECH_RMS_THRESHOLD;

  if (!state.speaking) {
    if (!voice) return { state, event: null };
    return { state: { speaking: true, startedAt: nowMs, lastVoiceAt: nowMs }, event: 'start' };
  }

  const lastVoiceAt = voice ? nowMs : state.lastVoiceAt;
  const duration = nowMs - state.startedAt;
  const silence = nowMs - lastVoiceAt;

  // 長すぎる区間は強制的に切る(巨大WAVを作らない)
  if (duration >= MAX_SPEECH_MS) {
    return { state: initialVad(), event: 'end' };
  }
  if (silence >= SILENCE_TO_END_MS) {
    // 短すぎる区間(咳・物音)は捨てる
    const event = duration - silence >= MIN_SPEECH_MS ? 'end' : 'discard';
    return { state: initialVad(), event };
  }
  return { state: { speaking: true, startedAt: state.startedAt, lastVoiceAt }, event: null };
}
