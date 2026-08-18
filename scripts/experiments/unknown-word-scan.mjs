// ヒナタの全発話を時系列走査し、「その時点までの経験に存在しない単語」の発話を検出する。
// 単語=漢字2+文字 or カタカナ2+文字の連なり(近似)。読み取り専用。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MEM = 'C:/dev/mycodex/lifeform/memory';
const PERSONA = 'C:/dev/mycodex/lifeform/persona';

const tokenize = (s) => {
  if (typeof s !== 'string') return [];
  return [...(s.match(/[一-龯々]{2,}|[ァ-ヶー]{2,}/g) ?? [])];
};

const known = new Set();
const learnFrom = (s) => { for (const t of tokenize(s)) known.add(t); };

// ---- 生得の種(生まれた時からある知識): persona一式・世界地図・チャンネル表・固定ラベル ----
for (const f of readdirSync(PERSONA)) learnFrom(readFileSync(join(PERSONA, f), 'utf8'));
try { learnFrom(readFileSync('C:/dev/mycodex/lifeform/tv-channels.json', 'utf8')); } catch {}
try { learnFrom(readFileSync(join(MEM, 'known-world.migrated.json'), 'utf8')); } catch {}
// situationNote/コードが生成する固定語彙(コード由来=漏れではない)
learnFrom('テレビ としょかん まよなか 記憶 時間 世界 お月さま 観覧車 ブランコ 風車 電柱 電線 変圧器 時計塔 黒板 電光掲示板 クレーン カレンダー 電卓 辞書 本棚 配信 幼年期');
// 世界の物体名(現在の世界+バックアップは近似で最初から既知とする=偽陽性を減らす保守側)
try {
  const ws = JSON.parse(readFileSync('C:/Users/haru-/AppData/Roaming/amateras/world-state.json', 'utf8'));
  const names = JSON.stringify(ws.objects ?? ws).match(/"(?:name|id|label|subject)":"([^"]+)"/g) ?? [];
  for (const n of names) learnFrom(n);
} catch {}

// ---- 全イベントを収集して時系列ソート ----
const events = [];
for (const f of readdirSync(MEM).filter((x) => x.startsWith('episodes-') && x.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(MEM, f), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try { const e = JSON.parse(line); if (e.ts) events.push(e); } catch {}
  }
}
// 日記・じぶんノート(14B統合の出力)は「その日の朝から既知」として入力扱い(保守側)
const diaryDir = join(MEM, 'diary');
if (existsSync(diaryDir)) {
  for (const f of readdirSync(diaryDir)) {
    const day = f.replace('.md', '');
    events.push({ ts: day + 'T21:00:00.000Z', kind: '_diary', text: readFileSync(join(diaryDir, f), 'utf8') });
  }
}
// 知識台帳(objects/*)も入力として時系列に混ぜる
const objDir = join(MEM, 'objects');
if (existsSync(objDir)) {
  for (const f of readdirSync(objDir)) {
    // 台帳ファイル名は種にしない(作成時刻が発話より後の場合があり、肝心の初出を隠す)
    for (const line of readFileSync(join(objDir, f), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try { const e = JSON.parse(line); if (e.ts) events.push({ ts: e.ts, kind: '_ledger', text: e.detail ?? '' }); } catch {}
    }
  }
}
events.sort((a, b) => (a.ts < b.ts ? -1 : 1));

// ---- 走査 ----
const M208 = '2026-08-15T12:00:00.000Z'; // 定型文全廃の境界(これ以前の発話はプログラム定型が混ざる)
let saysTotal = 0, saysPost = 0;
const flags = [];
let recentHeard = []; // 直前に聞いた言葉(文脈表示用)
for (const e of events) {
  if (e.kind === 'heard' || e.kind === 'saw_comment') {
    recentHeard.push((e.from ?? e.author ?? '?') + ':' + (e.text ?? '').slice(0, 40));
    if (recentHeard.length > 2) recentHeard.shift();
  }
  if (e.kind === 'say') {
    saysTotal++;
    const post = e.ts >= M208;
    if (post) saysPost++;
    const novel = tokenize(e.text).filter((t) => !known.has(t));
    if (novel.length > 0) flags.push({ ts: e.ts, text: (e.text ?? '').slice(0, 60), novel, post, ctx: [...recentHeard] });
    learnFrom(e.text); // 一度口にした言葉は以後は既知
  } else {
    // 入力: heard/saw_comment/tv/learned/日記/台帳など、텍스트を全部経験に積む
    learnFrom(e.text); learnFrom(e.what); learnFrom(e.summary); learnFrom(e.title);
    learnFrom(e.from); learnFrom(e.author); learnFrom(e.channel);
    if (e.data) learnFrom(JSON.stringify(e.data));
  }
}

console.log('総発話(say):', saysTotal, '/ M208(8/15定型全廃)以降:', saysPost);
console.log('未知語を含む発話:', flags.length, '件 / うちM208以降:', flags.filter((f) => f.post).length, '件');
console.log('\n=== M208以降(全発話が生成=真の候補) ===');
for (const f of flags.filter((x) => x.post)) {
  console.log(f.ts.slice(5, 16), JSON.stringify(f.novel.join(',')), '|', f.text.replace(/\n/g, '/'));
  console.log('    直前に聞いた:', f.ctx.join(' / ') || '(なし)');
}
console.log('\n=== M208以前(定型文混在期・参考) 先頭20件 ===');
for (const f of flags.filter((x) => !x.post).slice(0, 20)) console.log(f.ts.slice(5, 16), JSON.stringify(f.novel.join(',')), '|', f.text);
