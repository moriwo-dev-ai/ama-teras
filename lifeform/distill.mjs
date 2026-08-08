#!/usr/bin/env node
/**
 * 夜間蒸留バッチ(b案: 「学び、人格が出来上がる」の実装)
 *
 * その日のエピソード記憶(memory/episodes-YYYY-MM-DD.jsonl)を読み、
 *  1) 機械集計(行動数・聞いた言葉・見た変化)
 *  2) ローカルLLMでヒナタ一人称の日記(3〜5行)
 *  3) 人格カーネルへの反映「提案」(自動では書き換えない=オーナーが日記を見て取り込む)
 * を memory/diary/YYYY-MM-DD.md に書く。生ログは残す(上限運用は将来)。
 *
 * 使い方: node lifeform/distill.mjs [YYYY-MM-DD](省略時は今日)
 * デーモンが毎朝4時台に自動実行する(眠っている時間に今日を振り返る)。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBrain } from './brain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const day = process.argv[2] ?? new Date().toLocaleDateString('sv-SE'); // ローカル日付(UTC混入防止)
const epPath = join(HERE, 'memory', `episodes-${day}.jsonl`);
const outDir = join(HERE, 'memory', 'diary');
const outPath = join(outDir, `${day}.md`);

if (!existsSync(epPath)) {
  console.log(`エピソードなし: ${epPath}`);
  process.exit(0);
}
const episodes = readFileSync(epPath, 'utf8').split('\n').filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean);

// ---- 1) 機械集計 ----
const count = (k) => episodes.filter((e) => e.kind === k).length;
const heard = episodes.filter((e) => e.kind === 'heard').map((e) => e.text).slice(-20);
const comments = episodes.filter((e) => e.kind === 'saw_comment').slice(-20);
const changes = episodes.filter((e) => e.kind === 'saw_world_change').slice(-20);
const says = episodes.filter((e) => e.kind === 'say').map((e) => e.text).slice(-20);
const digest = [
  `- 行動: ${count('act')}回 / 発話: ${says.length}回 / 聞いた言葉: ${count('heard')}件`,
  `- 視聴者コメント: ${count('saw_comment')}件 / 世界の変化: ${count('saw_world_change')}件`,
];

// ---- 2) 日記(ローカルLLM。未導入なら機械集計だけ残す) ----
let diary = '(きょうは頭脳がお休みだったので、日記は書けなかった)';
let proposal = '(なし)';
const brain = await detectBrain();
if (brain !== null) {
  const persona = (() => { try { return readFileSync(join(HERE, 'persona', 'core.md'), 'utf8'); } catch { return ''; } })();
  const material =
    `聞いた言葉: ${heard.join(' / ') || 'なし'}\n` +
    `視聴者コメント: ${comments.map((c) => `${c.author}「${c.text}」`).join(' / ') || 'なし'}\n` +
    `世界の変化: ${changes.map((c) => c.type + ':' + c.id).join(' / ') || 'なし'}\n` +
    `自分の発話: ${says.join(' / ') || 'なし'}`;
  const ask = async (sys, user) => {
    try {
      const res = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: brain.model, stream: false, options: { temperature: 0.7, num_predict: 300 },
          messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
        }),
        signal: AbortSignal.timeout(60_000),
      });
      return ((await res.json()).message?.content ?? '').trim() || null;
    } catch { return null; }
  };
  diary = (await ask(
    `${persona}\n上の人格の女の子として、きょう一日のできごとを日記に書く。3〜5行・一人称・ため口。事実は下の材料にあるものだけを使い、なかったことは書かない。`,
    material,
  )) ?? diary;
  proposal = (await ask(
    'あなたは人格エンジニア。下の「今日の経験」から、人格カーネル(性格・口癖・好き嫌い・関係性)に追記する価値のある学びを箇条書きで0〜3個だけ提案する。無ければ「なし」とだけ書く。過激な変更・設定矛盾は提案しない。',
    material,
  )) ?? proposal;
}

// ---- 3) 書き出し ----
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, [
  `# ${day} のヒナタ`,
  '', '## きょうのすうじ', ...digest,
  '', '## 日記', diary,
  '', '## 人格カーネルへの提案(オーナー確認用・自動反映はしない)', proposal,
  '',
].join('\n'));
console.log(`蒸留完了: ${outPath}(brain=${brain?.model ?? 'なし'})`);
