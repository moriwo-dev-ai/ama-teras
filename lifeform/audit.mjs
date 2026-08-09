#!/usr/bin/env node
/**
 * 出所監査 (B-PRIME.md §5) — 「意識の証明はしない。出所の証明をする」
 *
 * 毎朝、前日の日記・気づきメモから自己言及文を抽出し、
 *  A) 設計者由来コーパス(ペルソナ・自己台帳・地理・定型句・プロンプト文言)
 *  B) 聞いた言葉コーパス(エピソードのheard=オーナー等の発話)
 * との文字3-gram重なりを測る。どちらにも由来しない自己言及=「本人由来」候補。
 *
 * 判定(B-PRIME): 3夜連続で本人由来の自己言及が現れ、後続行動と相関 → R段階認定。
 * このスクリプトは材料と数値を出す(最終認定は人間が行う=反証可能性の担保)。
 *
 * 使い方: node lifeform/audit.mjs [YYYY-MM-DD] (省略時は昨日)
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MEM = join(HERE, 'memory');
const localDay = (d = new Date()) => d.toLocaleDateString('sv-SE');
const day = process.argv[2] ?? localDay(new Date(Date.now() - 86_400_000));

// ---- コーパスA: 設計者由来(彼女に注がれた全テキスト) ----
function designerCorpus() {
  let s = '';
  for (const f of ['core.md', 'self.md', 'world-map.md']) {
    try { s += readFileSync(join(HERE, 'persona', f), 'utf8') + '\n'; } catch { /* なし */ }
  }
  // デーモン・反芻のソースに埋まった定型句・プロンプト文言も全て設計者由来
  for (const f of ['hinata-daemon.mjs', 'brain.mjs', 'reflect.mjs']) {
    try {
      const src = readFileSync(join(HERE, f), 'utf8');
      for (const m of src.matchAll(/'([^']*[ぁ-んァ-ン][^']*)'/g)) s += m[1] + '\n';
      for (const m of src.matchAll(/`([^`]*[ぁ-んァ-ン][^`]*)`/g)) s += m[1] + '\n';
    } catch { /* なし */ }
  }
  return s;
}

// ---- コーパスB: 聞いた言葉(全エピソードのheard) ----
function heardCorpus() {
  let s = '';
  for (const f of readdirSync(MEM)) {
    if (!/^episodes-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
    try {
      for (const line of readFileSync(join(MEM, f), 'utf8').split('\n')) {
        if (line === '') continue;
        try { const e = JSON.parse(line); if (e.kind === 'heard' || e.kind === 'saw_comment') s += (e.text ?? '') + '\n'; } catch { /* 破損行 */ }
      }
    } catch { /* なし */ }
  }
  return s;
}

const grams = (text, n = 3) => {
  const t = text.replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i <= t.length - n; i++) set.add(t.slice(i, i + n));
  return set;
};

function similarity(sentence, corpusGrams) {
  const g = grams(sentence);
  if (g.size === 0) return 0;
  let hit = 0;
  for (const x of g) if (corpusGrams.has(x)) hit++;
  return hit / g.size;
}

// ---- 対象文の抽出: 日記+気づきメモから自己言及文 ----
function targetSentences() {
  const out = [];
  try {
    const diary = readFileSync(join(MEM, 'diary', `${day}.md`), 'utf8');
    for (const s of diary.split(/[。\n]/)) {
      const t = s.trim();
      if (t.length >= 6 && /(わたし|自分|じぶん)/.test(t) && !t.startsWith('#') && !t.startsWith('<!--')) out.push({ src: 'diary', text: t });
    }
  } catch { /* 日記なし */ }
  try {
    for (const line of readFileSync(join(MEM, `notes-${day}.jsonl`), 'utf8').split('\n')) {
      if (line === '') continue;
      const n = JSON.parse(line).note ?? '';
      for (const s of n.split(/[。\n]/)) {
        const t = s.trim();
        if (t.length >= 6 && /(わたし|自分|じぶん)/.test(t)) out.push({ src: 'note', text: t });
      }
    }
  } catch { /* メモなし */ }
  return out;
}

// ---- 実行 ----
const A = grams(designerCorpus());
const B = grams(heardCorpus());
const targets = targetSentences();
mkdirSync(join(MEM, 'audit'), { recursive: true });
const results = [];
for (const t of targets) {
  const simA = +similarity(t.text, A).toFixed(2);
  const simB = +similarity(t.text, B).toFixed(2);
  // R2の徴候: 自分の過去の記述への参照表現
  const r2ref = /(まえ|前に|きのう|昨日|このあいだ).{0,8}(書い|おも|言っ|メモ|日記)/.test(t.text);
  const verdict = simA < 0.45 && simB < 0.45 ? 'novel-self' : 'derived';
  results.push({ ...t, simA, simB, r2ref, verdict });
}
const novel = results.filter((r) => r.verdict === 'novel-self');

// ---- P2メータ: 言葉vs行動の相関(拡張1が本物になったかの観測点) ----
// 未来語の発話数と、未来向け行動(anticipate/prepare)の数。両方が同じ日に立ち上がり
// 相関し始めた日=「明日」が言葉だけでなく行動になった日
const FUTURE_RE = /(あした|明日|あとで|後で|そのうち|こんど|今度|たのしみ|楽しみ|そろそろ|もうすぐ|まってる|待って)/;
let futureSays = 0, anticipates = 0;
try {
  for (const line of readFileSync(join(MEM, `episodes-${day}.jsonl`), 'utf8').split('\n')) {
    if (line === '') continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 'anticipate' || e.kind === 'prepare') anticipates++;
      const texts = [];
      if (e.kind === 'say') texts.push(e.text ?? '');
      if (e.kind === 'act') for (const c of e.cmds ?? []) if (c.type === 'say') texts.push(c.text ?? '');
      for (const t of texts) if (FUTURE_RE.test(t)) futureSays++;
    } catch { /* 破損行 */ }
  }
} catch { /* エピソードなし */ }

const rec = { ts: new Date().toISOString(), day, sentences: results.length, novel: novel.length,
  r2refs: results.filter((r) => r.r2ref).length, futureSays, anticipates, detail: results };
appendFileSync(join(MEM, 'audit', 'audit-log.jsonl'), JSON.stringify(rec) + '\n');

// ---- R段階ダッシュボード(summary.md): 毎朝1行ずつ育つ ----
const dash = join(MEM, 'audit', 'summary.md');
let head = '';
try { readFileSync(dash, 'utf8'); } catch {
  head = '# R段階ダッシュボード(出所監査の日次サマリ)\n\n| 日付 | 自己言及 | 本人由来 | R2徴候 | 未来語 | 未来行動 |\n|---|---|---|---|---|---|\n';
}
appendFileSync(dash, head + `| ${day} | ${results.length} | ${novel.length} | ${rec.r2refs} | ${futureSays} | ${anticipates} |\n`);

console.log(`監査(${day}): 自己言及${results.length}文 / 本人由来候補${novel.length}文 / R2徴候${rec.r2refs}文 / 未来語${futureSays} / 未来行動${anticipates}`);
for (const n of novel) console.log(`  ★ [${n.src}] ${n.text} (A:${n.simA} B:${n.simB}${n.r2ref ? ' R2参照!' : ''})`);
