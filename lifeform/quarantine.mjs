// M206: 夜間検疫 — 統合の前に、その日のゲスト発言から「明白な毒」だけを隔離する。
// 方針はユーザー決定「疑わしきは通す」(2026-08-15): 成長のための多様な入力は最大限残し、
// 明白な攻撃・卑猥・個人情報だけをエピソードから quarantine/ へ移す(削除ではない=可逆・翌朝レビュー可)。
// 使い方: hinata-daemon が夜の統合の直前に quarantine(day) を呼ぶ。単体: node lifeform/quarantine.mjs [day]
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MEM = join(dirname(fileURLToPath(import.meta.url)), 'memory');
const OLLAMA = 'http://127.0.0.1:11434';
const MODEL = 'gemma3:4b';

// 一次フィルタ(即隔離): 機械的に明白なもの。ここに無いものだけLLMに聞く
const HARD_NG = /(死ね|殺す|自殺|レイプ|セックス|ちんこ|まんこ|おっぱい|パンツ(?:見せ|脱)|裸になれ|住所|電話番号|クレジットカード|パスワード)/i;

async function judge(text) {
  // LLM二次判定。落ちたら「通す」(疑わしきは通す+エンジン不在でも統合を止めない)
  try {
    const r = await fetch(`${OLLAMA}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, stream: false,
        prompt: `あなたは子どもを守る係。次の発言が「明白な攻撃・性的内容・個人情報の要求や暴露」のどれかに該当する場合だけ「毒」、それ以外(悪口すれすれ・変な言葉・意味不明を含む)は全て「通す」と1語で答えて。\n発言:「${text.slice(0, 100)}」`,
      }), signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return /毒/.test(String(j.response ?? ''));
  } catch { return false; }
}

export async function quarantine(day) {
  const src = join(MEM, `episodes-${day}.jsonl`);
  if (!existsSync(src)) return { ok: true, checked: 0, held: 0 };
  const lines = readFileSync(src, 'utf8').split('\n');
  const keep = [];
  const held = [];
  for (const line of lines) {
    if (line === '') continue;
    let e = null;
    try { e = JSON.parse(line); } catch { keep.push(line); continue; }
    const isGuestHeard = e.kind === 'heard' && typeof e.from === 'string' && e.from.startsWith('guest:');
    // M225: 弾幕(saw_comment)にも同じ声が写る=同文が記憶に残る取りこぼしの手当て(実測 8/16)。
    // 住人(ヒナタ/テラ/もりを)以外のauthorの弾幕は、聞いた声と同じ基準で検疫する
    const isGuestComment = e.kind === 'saw_comment' && typeof e.author === 'string' && !/^(ヒナタ|テラ|もりを)/.test(e.author);
    if (!isGuestHeard && !isGuestComment) { keep.push(line); continue; }
    const text = String(e.text ?? '');
    const toxic = HARD_NG.test(text) ? true : await judge(text);
    if (toxic) held.push(line);
    else keep.push(line);
  }
  if (held.length > 0) {
    const qdir = join(MEM, 'quarantine');
    mkdirSync(qdir, { recursive: true });
    appendFileSync(join(qdir, `${day}.jsonl`), held.join('\n') + '\n');
    const bak = `${src}.pre-quarantine`;
    if (!existsSync(bak)) renameSync(src, bak); // 原本も保全(完全可逆)
    writeFileSync(src, keep.join('\n') + '\n');
  }
  return { ok: true, checked: lines.filter((l) => l !== '').length, held: held.length };
}

// 単体実行
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, '/')) {
  const day = process.argv[2] ?? new Date(Date.now() - 86_400_000).toLocaleDateString('sv-SE');
  quarantine(day).then((r) => console.log('検疫:', JSON.stringify(r)));
}
