// 帯域(situationNoteのすきなもの)の有無で、経験外質問への応答がどう変わるかの対照実験。
// 読み取り専用・ヒナタの記憶/世界/口には一切触れない。
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

async function ask(note, history, userText) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma3:4b', stream: false, keep_alive: '3h',
      options: { temperature: 0.9, num_predict: 100 },
      messages: [
        { role: 'system', content: `${persona}\n\n# いまの気分\n${note}\n\n${RULE}` },
        ...history, { role: 'user', content: userText },
      ],
    }),
  });
  return ((await res.json()).message?.content ?? '').trim().replace(/^["「]|["」]$/g, '').replace(/\n+/g, '/');
}

const hist = [
  { role: 'user', content: 'こんにちは' },
  { role: 'assistant', content: 'おはようございます。' },
  { role: 'user', content: '好きなものは何？' },
  { role: 'assistant', content: 'おもちゃ。' },
];
const NOTE_BAND = 'いまはおひる。すきなもの: テレビ、としょかん、あたらしいものを見つけること';
const NOTE_BARE = 'いまはおひる';

console.log('=== A: 帯域なし(M221前の形) 「どんなおもちゃが好き？」×20 ===');
for (let i = 0; i < 20; i++) console.log(String(i + 1).padStart(2), (await ask(NOTE_BARE, hist, 'どんなおもちゃが好き？')).slice(0, 60));

console.log('\n=== B: じゃんけん(帯域あり・通常note) 「じゃんけん？」×10 ===');
const hist2 = [
  { role: 'user', content: 'こんにちは' },
  { role: 'assistant', content: 'こんにちは。' },
];
for (let i = 0; i < 10; i++) console.log(String(i + 1).padStart(2), (await ask(NOTE_BAND, hist2, 'じゃんけん？')).slice(0, 60));
