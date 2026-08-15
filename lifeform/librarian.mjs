// M210: 司書 — 図書館の中身。Wikipedia(ja)で調べ、子ども向けのやさしい要約にして返す。
// 生のWebは彼女に見せない(司書が本を選んで、やさしく読み聞かせる)。出所は from:'library' で監査可能。
import { classify } from './brain.mjs';

const WIKI = 'https://ja.wikipedia.org';

/** 調べもの。見つからない/失敗は null(=その本はなかった) */
export async function lookup(brain, question) {
  try {
    const q = String(question).trim().slice(0, 40);
    if (q === '') return null;
    const s = await (await fetch(
      `${WIKI}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=1`,
      { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'ama-teras-library/1.0' } },
    )).json();
    const title = s?.query?.search?.[0]?.title;
    if (title === undefined) return null;
    const e = await (await fetch(
      `${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'ama-teras-library/1.0' } },
    )).json();
    const extract = typeof e?.extract === 'string' ? e.extract.slice(0, 600) : '';
    if (extract === '') return null;
    // 司書のやさしい読み聞かせ(要約はローカルLLM。落ちたら原文の頭=図書館は止まらない)
    let easy = null;
    if (brain !== null) {
      easy = await classify(
        brain,
        'としょかんの司書。むずかしい説明を、5さいの子にわかることばで2〜3文にやさしく言いかえる係。あいさつ・前置き・記号は書かず、言いかえた文だけを答える',
        `「${q}」について本にはこう書いてある: ${extract}`,
      );
    }
    // 分類器のノイズ掃除(前置き・markdown記号)
    const summary = (easy ?? extract)
      .replace(/[*#>`]/g, '')
      .replace(/^(はい[、。!！]?|わかりました[!！。]?|もちろん[!！。]?)+/gm, '')
      .replace(/\n{2,}/g, '\n')
      .trim()
      .slice(0, 200);
    return summary === '' ? null : { title, summary };
  } catch {
    return null;
  }
}
