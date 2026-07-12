/**
 * M42-2(TUKU-yomi): 口 — 実際にPCのスピーカーから喋る。
 *
 * OSの音声合成(speechSynthesis)を使う。ローカル・依存ゼロ・APIに何も送らない。
 * 日本語の声が見つからなければ main 側の PowerShell(System.Speech)へフォールバックする。
 */

/** 日本語の声を選ぶ。無ければ null(= main のフォールバックへ) */
export function pickJapaneseVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return voices.find((v) => v.lang === 'ja-JP') ?? voices.find((v) => v.lang.startsWith('ja')) ?? null;
}

/**
 * 喋る。戻り値は「rendererの音声合成で喋れたか」。
 * false なら呼び出し側が main のフォールバックを叩く
 */
/**
 * 先頭の「間」。Chromium の音声合成は、しばらく黙っていた後の1回目で
 * **冒頭の数百ミリ秒を取りこぼす**(「おかえり」が「かえり」になる。実機で発生)。
 *
 * 別の無音ユーティランスを先に流す方式は効かなかった(volume 0 はエンジンが飛ばす)。
 * **同じ発話の先頭に読点を入れて間を作る** — 取りこぼされるのが「間」の側になる
 */
const LEAD_PAUSE = '、、';

export function speak(text: string): boolean {
  if (typeof window.speechSynthesis === 'undefined') return false;
  const voice = pickJapaneseVoice(window.speechSynthesis.getVoices());
  if (voice === null) return false;

  // 前の発話が残っていると頭切れの原因になるので、必ず止めてから
  window.speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(`${LEAD_PAUSE}${text}`);
  utter.voice = voice;
  utter.lang = voice.lang;
  // 月らしく少しゆっくり・控えめに
  utter.rate = 0.95;
  utter.volume = 0.9;
  window.speechSynthesis.speak(utter);
  return true;
}
