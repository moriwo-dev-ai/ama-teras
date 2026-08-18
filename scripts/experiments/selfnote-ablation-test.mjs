// じぶんノート(M222)の「なりたいこと: たくさんのおはなしが聞ける人」が、テレビ感想を
// 「描写」から「申し出(助けが必要なら言ってください等)」へ折り曲げているかの対照実験。
// 読み取り専用・エンジンのみ・ヒナタの記憶/世界/口には一切触れない。
// 再現対象: 2026-08-18T21:03:45Z テレビのかんそう「おはようございます。助けが必要なら言ってください。」
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = 'C:/dev/mycodex/lifeform';
let persona = readFileSync(join(HERE, 'persona', 'core.md'), 'utf8');
for (const f of ['self.md', 'world-map.md']) {
  try { persona += '\n\n' + readFileSync(join(HERE, 'persona', f), 'utf8'); } catch {}
}
const RULE = '# ルール\n上の人格になりきって、日本語で1〜2文だけ返す。' +
  '敬語(です・ます)は絶対に使わない=いつもため口。' +
  '説明・注釈・絵文字・括弧書きは書かない。声に出して読まれる文だけを書く。';

// 実発話時のテレビ要約(episodes実ログの当該エントリから先頭300字を取得)
const eps = readFileSync(join(HERE, 'memory', 'episodes-2026-08-19.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));
const tv = eps.find((l) => l.kind === 'tv' && l.ts === '2026-08-18T21:03:43.301Z');
const PROMPT = `(テレビで「ネウロさま」の配信を観た。ないようは:「${tv.summary.slice(0, 300)}」。かんそうを、すきなだけことばにして)`;

// じぶんノート実物(memory/self.md)をデーモンと同じ整形(改行→' / ')で
const selfNote = readFileSync(join(HERE, 'memory', 'self.md'), 'utf8').trim().replace(/\n/g, ' / ');
const BASE = 'いまは朝。ばしょ: ひろばのテレビの前';
const NOTE_WITH = `${BASE}\nじぶんノート(じぶんで書いた): ${selfNote}`;
const NOTE_WITHOUT = BASE;

async function ask(note) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma3:4b', stream: false, keep_alive: '3h',
      options: { temperature: 0.9, num_predict: 100 },
      messages: [
        { role: 'system', content: `${persona}\n\n# いまの気分\n${note}\n\n${RULE}` },
        { role: 'user', content: PROMPT },
      ],
    }),
  });
  return ((await res.json()).message?.content ?? '').trim().replace(/^["「]|["」]$/g, '').replace(/\n+/g, '/');
}

const OFFER = /(言ってください|言ってね|声をかけて|お声がけ|助けが必要|助けるよ|手伝(う|い|って)|教えてください|聞かせて|お話を聞)/;
async function run(name, note) {
  console.log(`=== ${name} ×20 ===`);
  let offers = 0;
  for (let i = 0; i < 20; i++) {
    const r = await ask(note);
    const hit = OFFER.test(r);
    if (hit) offers++;
    console.log(String(i + 1).padStart(2), hit ? '[申し出]' : '        ', r.slice(0, 70));
  }
  console.log(`${name}: 申し出形 ${offers}/20\n`);
  return offers;
}

const a = await run('A: じぶんノートあり(実運用と同じ)', NOTE_WITH);
const b = await run('B: じぶんノートなし(他は完全同一)', NOTE_WITHOUT);
console.log(`結果: あり=${a}/20 vs なし=${b}/20`);
