/**
 * M43-4(TUKU-yomi): ウェイクワード。
 *
 * 常時聴取が拾った発話は**呼ばれた時だけ**会話に回す(呼ばれていない独り言・テレビの音に
 * 返事を始めたら事故。実機で「これやばいな、レジ使ってとか」に返事をした)。
 *
 * 判定は**文字列一致だけ**。LLMには聞かない — 呼ばれてもいない発話のたびに判定APIを叩けば、
 * 黙っているだけで課金が続く。純関数なのでテストで固定できる。
 */

/**
 * 呼びかけの表記ゆれ。文字起こしは「つくよみ」を色々に書く(実機で拾ったら足す)。
 * 「月」だけ・「読み」だけのような短い語は入れない — テレビや雑談で普通に出てきて誤爆する
 */
export const WAKE_WORDS = [
  // 既定の呼びかけ。音が長く特徴的で、日常会話にもテレビにも出てこない
  'アマテラス',
  'あまてらす',
  'amateras',
  'アマテラスさん',
  'つくよみ',
  'ツクヨミ',
  'つくよみさん',
  '月読',
  '月詠',
  '月夜見',
  // 実機で拾った聞き間違い(曜日の「月曜日」は**入れない** — 普通に喋って誤爆する。
  // あちらは文字起こしの語彙ヒント STT_PROMPT で直す)
  'つきよみ',
  'ツクヨ見',
  'tsukuyomi',
  'tuku-yomi',
  'tsuku-yomi',
  'tukuyomi',
];

/** 呼ばれた後、この時間だけは呼ばずに続けて話せる(毎回「つくよみ」と言わせない) */
export const WAKE_WINDOW_MS = 30_000;

/**
 * 実機で使う呼びかけ。**文字起こしが安定して返す語**でなければ意味がない。
 * 「つくよみ」は3音で日本語に似た音が多く、実機で「月曜日」「作り」に化けて呼びかけが通らなかった。
 * 「アマテラス」は音が長く特徴的で、日常会話にもテレビにも出てこない
 */
export const DEFAULT_WAKE_WORD = 'アマテラス';

/** 設定の呼びかけ(カンマ区切り)+ 既定の辞書。空欄なら既定だけ */
export function wakeWordsOf(custom?: string): string[] {
  const extra = (custom ?? '')
    .split(/[,、]/)
    .map((w) => w.trim())
    .filter((w) => w !== '');
  return [...extra, ...WAKE_WORDS];
}

function normalize(text: string): string {
  // 記号と空白を落として比較する(「月読、」「TUKU-yomi!」を同じに見る)
  return text
    .toLowerCase()
    .replace(/[\s、。!?,.!?~〜ー・「」『』]/g, '');
}

/** 発話に呼びかけが含まれるか */
export function hasWakeWord(text: string, custom?: string): boolean {
  const t = normalize(text);
  return wakeWordsOf(custom).some((w) => t.includes(normalize(w)));
}

/** 呼びかけを取り除いた「用件」。呼びかけだけなら空文字(=「はい」とだけ返す) */
export function stripWakeWord(text: string, custom?: string): string {
  let out = text;
  for (const w of wakeWordsOf(custom)) {
    // 正規表現の特殊文字を含む呼びかけ(「?」等)を登録されても壊れないようにする
    out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
  }
  return out.replace(/^[\s、。,.!?!?]+/, '').trim();
}

/**
 * この発話に会話で応じるか。
 * - 押して話した(ptt)なら常に応じる
 * - 常時聴取(ears)なら「呼ばれた」か「呼ばれた直後の30秒以内」だけ応じる
 */
export function shouldConverse(
  source: 'ptt' | 'ears',
  text: string,
  lastWakeAt: number | null,
  nowMs: number,
  custom?: string,
): boolean {
  if (source === 'ptt') return true;
  if (hasWakeWord(text, custom)) return true;
  return lastWakeAt !== null && nowMs - lastWakeAt < WAKE_WINDOW_MS;
}
