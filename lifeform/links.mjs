/**
 * つながる記憶(M171)。台帳(1エンティティ=1ノート)の間にリンクを張る=人間の連想の配線。
 * 原則: 構造(ノート+リンク+減衰)は設計してよい。リンクの中身は経験からのみ生える。
 *  - 経路1: 共起(ヘッブ則・昼・自動) — 同じ3分窓で一緒に現れた対象同士が結びつく(+0.5、同一ペア60秒1回)
 *  - 経路2: 夜の統合(言語化) — 大型モデルが「A→B: 理由」を抽出して強く結ぶ(+3・理由つき)
 *  - 想起: 活性化拡散1ホップ・上位k件だけ会話の帯域へ(高速・埋め込み不要・監査が読める)
 *  - 忘却: 使われないリンクは減衰(実効値が薄れる)。夜に掃除
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATH = join(HERE, 'memory', 'links.json');

let links = {};
try { links = JSON.parse(readFileSync(PATH, 'utf8')); } catch { /* 初生 */ }
function save() { try { writeFileSync(PATH, JSON.stringify(links)); } catch { /* noop */ } }

const keyOf = (a, b) => [a, b].sort().join('|');
const effOf = (e) => e.w * Math.pow(0.97, (Date.now() - e.lastAt) / 86_400_000); // 1日あたり3%減衰

export function strengthen(a, b, amount = 0.5, note) {
  if (a === b || a === '' || b === '') return;
  const k = keyOf(a, b);
  const e = links[k] ?? { w: 0, lastAt: 0 };
  // 昼の共起は同じ話題の連打で太りすぎないよう60秒に1回だけ。夜の言語化(amount>=1)は常に通す
  if (amount < 1 && Date.now() - e.lastAt < 60_000) return;
  e.w = Math.min(20, +(effOf(e) + amount).toFixed(2)); // 実効値へ加算=減衰を織り込んで育つ
  e.lastAt = Date.now();
  if (note !== undefined && note !== '') e.note = String(note).slice(0, 40);
  links[k] = e;
  save();
}

/** 活性化拡散(1ホップ): name とつながる対象を実効強度順に */
export function linksOf(name, k = 3) {
  const out = [];
  for (const [key, e] of Object.entries(links)) {
    const [a, b] = key.split('|');
    if (a !== name && b !== name) continue;
    const eff = effOf(e);
    if (eff < 0.3) continue;
    out.push({ other: a === name ? b : a, eff: +eff.toFixed(2), note: e.note });
  }
  return out.sort((x, y) => y.eff - x.eff).slice(0, k);
}

/** 夜の掃除: 薄れきったリンクは本当に消える(忘却の物理) */
export function pruneLinks() {
  let removed = 0;
  for (const [key, e] of Object.entries(links)) {
    if (effOf(e) < 0.2) { delete links[key]; removed++; }
  }
  if (removed > 0) save();
  return removed;
}

export function linkCount() { return Object.keys(links).length; }
