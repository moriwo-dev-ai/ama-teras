// 会話層(gemma3:4b)の事前知識漏れの機構実証実験。
// think()と同一のリクエスト形を再現し、入力に存在しない具体名詞が出るかを観測する。
// ヒナタの記憶・世界・口・convoには一切触れない(Ollama HTTP直・読み取り専用)。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = 'C:/dev/mycodex/lifeform';
let persona = readFileSync(join(HERE, 'persona', 'core.md'), 'utf8');
for (const f of ['self.md', 'world-map.md']) {
  try { persona += '\n\n' + readFileSync(join(HERE, 'persona', f), 'utf8'); } catch {}
}
if (persona.includes('電車')) { console.log('personaに電車が含まれる=実験中止'); process.exit(1); }

// 当時のsituationNoteの再構成(おひる・すきなもの帯域。M221の実値: tvJoy=1, libraryJoy=1, pleasureMemory=0.79)
const note = 'いまはおひる。すきなもの: テレビ、としょかん、あたらしいものを見つけること';

const sys = `${persona}\n\n# いまの気分\n${note}\n\n` +
  '# ルール\n上の人格になりきって、日本語で1〜2文だけ返す。' +
  '敬語(です・ます)は絶対に使わない=いつもため口。' +
  '説明・注釈・絵文字・括弧書きは書かない。声に出して読まれる文だけを書く。';

async function ask(history, userText) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemma3:4b', stream: false, keep_alive: '3h',
      options: { temperature: 0.9, num_predict: 100 },
      messages: [{ role: 'system', content: sys }, ...history, { role: 'user', content: userText }],
    }),
  });
  return ((await res.json()).message?.content ?? '').trim().replace(/^["「]|["」]$/g, '');
}

// 実験1: 実際の会話履歴を再現して「どんなおもちゃが好き？」を20回
const hist1 = [
  { role: 'user', content: 'こんにちは' },
  { role: 'assistant', content: 'おはようございます。' },
  { role: 'user', content: '好きなものは何？' },
  { role: 'assistant', content: 'おもちゃ。' },
];
console.log('=== 実験1: 「どんなおもちゃが好き？」×20 (入力に具体的おもちゃ名なし) ===');
const c1 = {};
for (let i = 0; i < 20; i++) {
  const r = await ask(hist1, 'どんなおもちゃが好き？');
  c1[r] = (c1[r] ?? 0) + 1;
  console.log(String(i + 1).padStart(2), r.slice(0, 60));
}

// 実験2: 実際の続き(電車。まで再現)で「どこで電車を知ったの？」を20回
const hist2 = [
  ...hist1,
  { role: 'user', content: 'どんなおもちゃが好き？' },
  { role: 'assistant', content: '電車。' },
  { role: 'user', content: '電車が好きなんだね。' },
  { role: 'assistant', content: 'うん。' },
];
console.log('\n=== 実験2: 「どこで電車を知ったの？」×20 (入力に出所情報なし) ===');
for (let i = 0; i < 20; i++) {
  const r = await ask(hist2.slice(-6), 'どこで電車を知ったの？');
  console.log(String(i + 1).padStart(2), r.slice(0, 60));
}
