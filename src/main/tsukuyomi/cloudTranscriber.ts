import OpenAI, { toFile } from 'openai';

/**
 * M42-7(TUKU-yomi): 耳 — クラウド文字起こし。
 *
 * **鉄則2(音声はAPIに送らない)は、勇太さんの承認のもとで変更した**(2026-07-12)。
 * 条件: 月読を使う間はイヤホンマイクを装着する(口元だけを拾い、同席者・テレビを拾いにくくする)。
 * この経路では**音声そのものが OpenAI に送られる**。だからこそ:
 *
 * - モードは設定で切り替え可(ローカル whisper に戻せる)。UI は今どちらかを必ず表示する
 * - 送った音声の**分数に日次上限**を設ける(青天井にしない)
 * - 一時ファイルは作らない(メモリのまま送って捨てる。ディスクに録音を残さない)
 */

/** 実際の送信。テストでは差し替える(ネットワークに出さない) */
export type CloudSttRunner = (wav: Buffer, signal: AbortSignal) => Promise<string>;

/**
 * 文字起こしモデル。gpt-4o-mini-transcribe は whisper-1 より日本語の数字・時刻に強く、安い
 * (実機で「13時」が「13日」に化けたのを踏まえて精度側を採る)
 */
export const CLOUD_STT_MODEL = 'gpt-4o-mini-transcribe';

/** 1日に送っていい音声の長さ(分)。既定60分 */
export const DEFAULT_CLOUD_MINUTES_PER_DAY = 60;

/**
 * WAV(16bit PCM)の秒数。ヘッダの byteRate で割るだけ。
 * 課金と上限は「送った音声の長さ」で数えるので、ここが狂うと上限が意味を失う
 */
export function wavSeconds(wav: Buffer): number {
  if (wav.length < 44) return 0;
  const byteRate = wav.readUInt32LE(28); // fmt チャンクの byteRate
  if (byteRate <= 0) return 0;
  return Math.max(0, (wav.length - 44) / byteRate);
}

/**
 * 文字起こしに渡す語彙ヒント。
 * **実機で「つくよみ」が「月曜日」になった**(呼びかけが通らない)。固有名詞を先に教えると
 * その語に寄せて聞き取ってくれる。曜日の「月曜日」を辞書に足すのは誤爆するので、こちらで直す
 */
export const STT_PROMPT = 'アマテラス、つくよみ、月読、TUKU-yomi、AMA-teras';

/**
 * **語彙ヒントがそのまま文字起こしとして返ってくることがある**(実機で発生)。
 * 無音・短すぎる音のときに起きる。そのまま通すと、ヒントに含まれる呼びかけ(「アマテラス」)を
 * 拾って月読が勝手に返事を始める。ヒントとほぼ同じ文は捨てる
 */
export function isPromptEcho(text: string, prompt: string = STT_PROMPT): boolean {
  const norm = (s: string): string => s.replace(/[\s、。,.:：]/g, '').toLowerCase();
  const t = norm(text);
  if (t === '') return false;
  const p = norm(prompt);
  // ヒントの語がそのまま並んでいるだけ(用件が無い)なら、それは文字起こしではない
  return p.includes(t) || t.includes(p);
}

export function defaultCloudRunner(apiKey: string): CloudSttRunner {
  const client = new OpenAI({ apiKey });
  return async (wav, signal) => {
    const file = await toFile(wav, 'utterance.wav', { type: 'audio/wav' });
    const res = await client.audio.transcriptions.create(
      { file, model: CLOUD_STT_MODEL, language: 'ja', prompt: STT_PROMPT },
      { signal },
    );
    return res.text;
  };
}

/**
 * クラウドで文字起こしする。**一時ファイルは作らない**(メモリのまま送る)。
 * 返すのはテキストだけ — 音声はここで捨てる
 */
export async function transcribeCloud(
  wav: Buffer,
  runner: CloudSttRunner,
  signal: AbortSignal = new AbortController().signal,
): Promise<string> {
  const text = (await runner(wav, signal)).trim();
  // 語彙ヒントのオウム返しは文字起こしではない(呼びかけを含むので、通すと勝手に返事をする)
  return isPromptEcho(text) ? '' : text;
}
