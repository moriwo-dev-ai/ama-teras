import { describe, expect, it } from 'vitest';
import {
  initialVad,
  MAX_SPEECH_MS,
  MIC_CONSTRAINTS,
  MIN_SPEECH_MS,
  rms,
  SILENCE_TO_END_MS,
  SPEECH_RMS_THRESHOLD,
  stepVad,
  type VadState,
} from '../../shared/tsukuyomiVad';

/**
 * M42-5b(TUKU-yomi): 常時聴取のVAD。
 * 判定は純関数なのでここで固定する(マイク実機はテストしない)。
 * 見ているのは「どこからどこまでを1回の発話として切り出すか」だけ。
 */

const LOUD = SPEECH_RMS_THRESHOLD * 2;
const QUIET = SPEECH_RMS_THRESHOLD / 2;

/** フレーム列を流して、起きたイベントを並べる */
function run(levels: { level: number; at: number }[]): (string | null)[] {
  let state: VadState = initialVad();
  const events: (string | null)[] = [];
  for (const { level, at } of levels) {
    const r = stepVad(state, level, at);
    state = r.state;
    events.push(r.event);
  }
  return events;
}

describe('M42-5b(TUKU-yomi) 耳: 常時聴取のVAD(送るのは喋った区間だけ)', () => {
  it('音量(RMS)の計算', () => {
    expect(rms(new Float32Array())).toBe(0);
    expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
    expect(rms(new Float32Array([1, -1, 1, -1]))).toBe(1);
  });

  it('声が出たら start、無音が続いたら end(この区間だけを文字起こしへ)', () => {
    const events = run([
      { level: QUIET, at: 0 }, // 無音
      { level: LOUD, at: 100 }, // 喋り始め
      { level: LOUD, at: 1000 },
      { level: QUIET, at: 1500 }, // 黙った
      { level: QUIET, at: 1500 + SILENCE_TO_END_MS }, // 無音が続いた → 区切る
    ]);
    expect(events).toEqual([null, 'start', null, null, 'end']);
  });

  it('短すぎる区間(咳・物音)は捨てる。文字起こししない', () => {
    const events = run([
      { level: LOUD, at: 0 }, // 一瞬の物音
      { level: QUIET, at: 100 },
      { level: QUIET, at: 100 + SILENCE_TO_END_MS },
    ]);
    expect(events).toEqual(['start', null, 'discard']);
    expect(MIN_SPEECH_MS).toBe(700);
  });

  it('長い会話は強制的に区切る(巨大なWAVを作らない)', () => {
    const events = run([
      { level: LOUD, at: 0 },
      { level: LOUD, at: MAX_SPEECH_MS - 1 },
      { level: LOUD, at: MAX_SPEECH_MS }, // 上限に到達 → 切る
    ]);
    expect(events).toEqual(['start', null, 'end']);
  });

  /**
   * 実機(Stage 5b・30分の常時聴取)で見つけた。`audio: true` の既定は AGC 有効で、
   * 静かな部屋の環境音が声のしきい値まで増幅され、20秒に1回 whisper が回り続けた
   * (環境音の21%が 0.02 超え / AGCを切ると 0.0%)。この定数が戻ったら同じ症状が再発する
   */
  it('マイクは自動ゲイン調整(AGC)を切って開く。環境音を声の大きさまで持ち上げない', () => {
    expect(MIC_CONSTRAINTS.autoGainControl).toBe(false);
    expect(MIC_CONSTRAINTS.noiseSuppression).toBe(true);
  });

  it('無音だけの時は何も起きない(常時マイクでも無音は捨てる)', () => {
    const events = run([
      { level: QUIET, at: 0 },
      { level: QUIET, at: 5000 },
      { level: QUIET, at: 60_000 },
    ]);
    expect(events).toEqual([null, null, null]);
  });
});
