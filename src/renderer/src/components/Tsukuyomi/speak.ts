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
export function speak(text: string): boolean {
  if (typeof window.speechSynthesis === 'undefined') return false;
  const voice = pickJapaneseVoice(window.speechSynthesis.getVoices());
  if (voice === null) return false;
  const utter = new SpeechSynthesisUtterance(text);
  utter.voice = voice;
  utter.lang = voice.lang;
  // 月らしく少しゆっくり・控えめに
  utter.rate = 0.95;
  utter.volume = 0.9;
  window.speechSynthesis.speak(utter);
  return true;
}
