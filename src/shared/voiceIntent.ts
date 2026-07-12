/**
 * M44-1(TUKU-yomi): 声で AMA-teras を操作する。
 *
 * 設計の芯は3つ。**岩戸ゲートは外さない**(実行の可否は人が決める)。
 *
 * 1. **許可リスト方式**。声で届く操作はここに書いてあるものだけ。モデルが何を言おうと、
 *    リストに無い名前は実行に行かない(自由記述のコマンドを実行させない)
 * 2. **復唱 + 確認語**。副作用のある操作は「◯◯を実行します。いいですか?」と読み上げ、
 *    次の発話に**確認語**(「実行して」「お願い」等)が含まれた時だけ動く。
 *    相槌の「うん」「はい」では動かさない — テレビの音・独り言・言い間違いで本番操作が飛ぶ
 * 3. **外部公開は声では実行しない**。X/Bluesky/Zenn投稿・GitHubリリースは取り返しがつかないので、
 *    画面の承認を残す(声からは「画面で承認してください」と案内するだけ)
 */

/** 声で届く操作。ここに無いものは実行に行かない */
export const VOICE_ACTIONS = [
  /** 読み取りだけ。確認なしで即実行してよい */
  'read.status',
  'read.approvals',
  'read.cho',
  /** 副作用あり。復唱 + 確認語が要る */
  'cho.add',
  'cho.done',
  'ops.godRun',
  /** 声では実行しない(画面の承認へ案内する) */
  'blocked.publish',
] as const;

export type VoiceAction = (typeof VOICE_ACTIONS)[number];

export interface VoiceIntent {
  action: VoiceAction;
  /** 操作の対象(帳の項目名・神のID等)。許可リストの側で意味を決める */
  target?: string;
  /** 復唱に使う一文(「明日13時のレビューを済みにします」) */
  say: string;
}

/** 副作用のある操作か(=復唱 + 確認語が要る) */
export function needsConfirm(action: VoiceAction): boolean {
  return action.startsWith('cho.') || action.startsWith('ops.');
}

/** 読み取りだけの操作か(=確認なしで即実行してよい) */
export function isReadOnly(action: VoiceAction): boolean {
  return action.startsWith('read.');
}

/**
 * 確認語。**明示的に「やれ」と言った言葉だけ**。
 * 「うん」「はい」「そうだね」は入れない — 相槌やテレビの音で本番操作が飛ぶ
 */
export const CONFIRM_WORDS = ['実行して', '実行', 'お願いします', 'お願い', 'やって', 'いいよ実行'];

/** 取り消しの言葉 */
export const CANCEL_WORDS = ['やめて', 'キャンセル', 'なし', 'やめとく', '違う'];

function normalize(text: string): string {
  return text.replace(/[\s、。,.!?!?]/g, '');
}

export function isConfirm(text: string): boolean {
  const t = normalize(text);
  return CONFIRM_WORDS.some((w) => t.includes(normalize(w)));
}

export function isCancel(text: string): boolean {
  const t = normalize(text);
  return CANCEL_WORDS.some((w) => t.includes(normalize(w)));
}

/** モデルが返した意図が「声で届く操作」か。知らない名前は捨てる(実行に行かせない) */
export function parseIntent(raw: string): VoiceIntent | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = (fenced !== null ? fenced[1] : raw) ?? '';
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const action = rec['action'];
  const say = rec['say'];
  if (typeof action !== 'string' || !(VOICE_ACTIONS as readonly string[]).includes(action)) return null;
  if (typeof say !== 'string' || say.trim() === '') return null;
  const target = rec['target'];
  return {
    action: action as VoiceAction,
    say: say.trim(),
    ...(typeof target === 'string' && target.trim() !== '' ? { target: target.trim() } : {}),
  };
}

/** 待たせた確認は**すぐ腐る**。放っておいた確認語で後から動き出すのが一番怖い */
export const CONFIRM_TTL_MS = 60_000;
