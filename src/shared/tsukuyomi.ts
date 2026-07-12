/**
 * M42-3(TUKU-yomi): 目① — 在席検知の判定(純関数)。
 *
 * **この段階ではAPIに何も送らない**。カメラのフレームはメモリ内で縮小され、
 * 前フレームとのピクセル差分を取るだけ。映像も静止画もディスクに書かない。
 *
 * 「誰が映っているか」は一切見ない(顔認識も人物識別もしない)。見ているのは
 * 「画面が動いているか」だけ — 記録に残るのは「10:42 離席 → 11:03 戻り」の一文。
 */

/** 在席状態 */
export type Presence = 'present' | 'away';

/**
 * 差分がこの値を超えたら「動きがあった」(0〜1。縮小画像の平均輝度差)。
 *
 * 実測(2026-07-12・実カメラ): 人が席にいて静止している時 0.004〜0.018、
 * 体が動いた時 0.03〜0.05。無人のセンサーノイズは 0.005 未満。
 * よって「動きあり」の閾値はノイズの少し上に置き、**戻りの判定は大きな動きで即断**する
 */
export const MOTION_THRESHOLD = 0.012;

/** 何回連続で動きが無ければ離席とみなすか(サンプル間隔 × これ = 離席判定までの時間) */
export const AWAY_AFTER_STILL_SAMPLES = 20;

/**
 * 戻りの判定は**滑走窓**で見る(実機で2回の誤爆を経ての設計)。
 *
 * - 「連続N回」方式は座って静止した瞬間にカウンタが落ちるので、戻りを取り逃す
 * - 「大きな動き1回」方式は目の前を通り過ぎただけで「おかえり」と言ってしまう
 *
 * → 直近 RETURN_WINDOW サンプル(18秒)のうち RETURN_MOTION_IN_WINDOW 回以上動いていたら戻り。
 * 通り過ぎ = 窓の中で1〜2回しか動かない。着席 = 大半のサンプルで動く
 */
export const RETURN_WINDOW = 6;
export const RETURN_MOTION_IN_WINDOW = 4;

export interface PresenceState {
  presence: Presence;
  /** 連続で動きが無かった回数(離席判定用) */
  stillCount: number;
  /** 直近の「動きがあったか」の履歴(新しいものが末尾。長さは RETURN_WINDOW まで) */
  recent: boolean[];
}

export function initialPresence(): PresenceState {
  return { presence: 'present', stillCount: 0, recent: [] };
}

/**
 * 2枚のグレースケール縮小画像の平均差分(0〜1)。
 * 長さが違う(解像度が変わった)場合は 1(=動きあり)として扱う
 */
export function frameDiff(prev: Uint8ClampedArray, next: Uint8ClampedArray): number {
  if (prev.length === 0 || prev.length !== next.length) return 1;
  let sum = 0;
  for (let i = 0; i < prev.length; i++) sum += Math.abs((prev[i] ?? 0) - (next[i] ?? 0));
  return sum / prev.length / 255;
}

/**
 * 状態遷移。返り値の event は帳に書くもの(null = 何も起きていない)。
 * 「戻り」は present への遷移時だけ。連続で戻りを言わない
 */
export function stepPresence(
  state: PresenceState,
  diff: number,
): { state: PresenceState; event: 'away' | 'returned' | null } {
  const moved = diff > MOTION_THRESHOLD;
  const stillCount = moved ? 0 : state.stillCount + 1;
  const recent = [...state.recent, moved].slice(-RETURN_WINDOW);
  const motionInWindow = recent.filter(Boolean).length;

  if (state.presence === 'present' && stillCount >= AWAY_AFTER_STILL_SAMPLES) {
    return { state: { presence: 'away', stillCount, recent }, event: 'away' };
  }
  // 戻り: 直近18秒のうち4回以上動いている時だけ。通り過ぎ(1〜2回)では戻さない
  if (state.presence === 'away' && motionInWindow >= RETURN_MOTION_IN_WINDOW) {
    // 戻ったら履歴を畳む(次に離席するまで再判定しない)
    return { state: { presence: 'present', stillCount, recent: [] }, event: 'returned' };
  }
  return { state: { presence: state.presence, stillCount, recent }, event: null };
}

/** 帳に書く一文(見たものは覚えるが、見たままは残さない) */
export function presenceText(event: 'away' | 'returned', now: Date): string {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return event === 'away' ? `${hhmm} 離席` : `${hhmm} 戻り`;
}
