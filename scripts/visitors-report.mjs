/**
 * M202: 来た人の集計(朝サイクル・夜サイクルの報告用)
 * - 見学(観戦URL): world-spectator-log.json = sidごとの個体。名乗った人/名無しの人を分けて数える
 * - 訪問(招待リンク): world-visitors.json の名簿 + 世界サーバのログから入場記録
 * 使い方: node scripts/visitors-report.mjs [YYYY-MM-DD(既定=今日)]
 */
import { readFileSync } from 'node:fs';

const DIR = 'C:/Users/haru-/AppData/Roaming/amateras';
const day = process.argv[2] ?? new Date().toLocaleDateString('sv-SE'); // ローカル日付
const dayStart = new Date(`${day}T00:00:00`).getTime();
const dayEnd = dayStart + 86_400_000;

const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const spec = readJson(`${DIR}/world-spectator-log.json`, {});
const invited = readJson(`${DIR}/world-visitors.json`, []);

const inDay = (iso) => { const t = Date.parse(iso); return t >= dayStart && t < dayEnd; };
const entries = Object.entries(spec);
const today = entries.filter(([, r]) => inDay(r.lastAt));
const named = today.filter(([, r]) => (r.lastName ?? '') !== '');
const anon = today.filter(([, r]) => (r.lastName ?? '') === '');
const firstTime = today.filter(([, r]) => inDay(r.firstAt));
const repeat = today.filter(([, r]) => !inDay(r.firstAt));

console.log(`【${day} の来た人】`);
console.log(`見学(観戦URL): のべ${today.length}人 — 名乗った人 ${named.length} / 名無し ${anon.length}`);
console.log(`  はじめて ${firstTime.length} / また来た ${repeat.length}`);
if (named.length > 0) {
  console.log('  名乗った人:');
  for (const [sid, r] of named.sort((a, b) => b[1].visits - a[1].visits)) {
    const t = new Date(r.lastAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    console.log(`   - ${r.lastName}(${sid.slice(0, 4).toUpperCase()}) ${r.visits}回目 最終${t}${r.names.length > 1 ? ` ※過去の名前: ${r.names.slice(0, -1).join(',')}` : ''}`);
  }
}
console.log(`招待リンクの名簿: ${invited.length}人分 発行済み`);
console.log(`累計(全期間): 個体 ${entries.length} / うち名乗った ${entries.filter(([, r]) => (r.lastName ?? '') !== '').length}`);
