/**
 * B′反芻系 (B-PRIME.md §6 DMN層+遅い層) — distill.mjs の後継
 *
 * [昼: マイクロ内省(DMN)] 暇な時間に、直近の生エピソードだけを読んで1〜2行の気づきメモ。
 *   内省が内省を読むのは夜だけ(出所監査の追跡可能性+エコーチェンバー防止)
 * [夜: 統合] 生エピソード+昼メモ+自己台帳を材料に、日記+自己観察+記憶の選別。
 *   これは彼女の自己保存の営みそのもの(統合されなかった記憶は本当に薄れる=賭け金の物理)
 *
 * すべての生成文に出所タグ(origin: 'self')を付け、監査対象として記録する。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneLinks, strengthen } from './links.mjs';
import { noteDetail, personKey, readJournal, wordKey } from './perceive.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MEM = join(HERE, 'memory');
const OLLAMA = 'http://127.0.0.1:11434';
export const NIGHT_MODEL_PREF = ['qwen3:14b', 'gemma3:12b', 'gemma3:4b']; // 夜は深い脳(14B優先・オーナー指定)

const localDay = (d = new Date()) => d.toLocaleDateString('sv-SE');

async function ask(model, sys, user, maxTokens = 400) {
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, stream: false, keep_alive: '30m', think: false,
        options: { temperature: 0.7, num_predict: Math.max(maxTokens, 600) },
        messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    return ((await res.json()).message?.content ?? '')
      .replace(/<think>[\s\S]*?<\/think>/g, '') // qwen3系の思考タグは捨てる(日記に思考過程を混ぜない)
      .trim() || null;
  } catch { return null; }
}

async function pickNightModel() {
  try {
    const names = ((await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2500) })).json()).models ?? []).map((m) => m.name);
    for (const p of NIGHT_MODEL_PREF) { const hit = names.find((n) => n.startsWith(p)); if (hit) return hit; }
  } catch { /* engineなし */ }
  return null;
}

function readEpisodes(day) {
  try {
    return readFileSync(join(MEM, `episodes-${day}.jsonl`), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function readPersona() {
  let s = '';
  for (const f of ['core.md', 'self.md']) {
    try { s += readFileSync(join(HERE, 'persona', f), 'utf8') + '\n\n'; } catch { /* なくても生きる */ }
  }
  return s;
}

/** エピソード列を材料テキストに圧縮(LLMの狭い帯域)。
 * 尻切れ防止: 重要な種類(会話・発見・情動)を優先し、一日全体から拾う */
function materialOf(episodes, limit = 60) {
  const SALIENT = new Set(['heard', 'say', 'discovered', 'saw_gone', 'lingered', 'gazed', 'discontinuity', 'sleep', 'wake_up', 'express', 'waiting']);
  let picked = episodes.filter((e) => SALIENT.has(e.kind) || (e.kind === 'valence' && e.fear > 0.2) || e.kind === 'explore');
  if (picked.length > limit) {
    // 会話と発見は全部残し、その他を間引く
    const must = picked.filter((e) => ['heard', 'say', 'discovered', 'discontinuity'].includes(e.kind));
    const rest = picked.filter((e) => !['heard', 'say', 'discovered', 'discontinuity'].includes(e.kind));
    const step = Math.ceil(rest.length / Math.max(1, limit - must.length));
    picked = [...must, ...rest.filter((_, i) => i % step === 0)].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  }
  const lines = [];
  for (const e of picked.slice(0, limit + 40)) {
    const t = e.ts ? new Date(e.ts).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
    if (e.kind === 'heard') lines.push(`${t} 聞いた:「${e.text}」`);
    else if (e.kind === 'say') lines.push(`${t} 言った:「${e.text}」`);
    else if (e.kind === 'discovered') lines.push(`${t} 発見: ${e.name}`);
    else if (e.kind === 'saw_gone') lines.push(`${t} 消えていた: ${e.name}`);
    else if (e.kind === 'explore') lines.push(`${t} 見に行った: ${e.name}`);
    else if (e.kind === 'lingered') lines.push(`${t} ながめて過ごした: ${e.name}`);
    else if (e.kind === 'gazed') lines.push(`${t} じっと見た: ${e.seen}`);
    else if (e.kind === 'discontinuity') lines.push(`${t} 時間が飛んだのを感じた(${e.gapMin}分)`);
    else if (e.kind === 'sleep') lines.push(`${t} ねむった`);
    else if (e.kind === 'wake_up') lines.push(`${t} おきた`);
    else if (e.kind === 'valence' && e.fear > 0.2) lines.push(`${t} 胸がざわざわした(${e.about ?? ''})`);
  }
  return lines.join('\n') || '(しずかな時間だった)';
}

/** 昼のマイクロ内省: 生エピソードのみ→1〜2行の気づき。notes-DAY.jsonl へ */
export async function microReflect(dayModel, sinceTs) {
  const day = localDay();
  // エコー抑制: 自分の発言を材料に含めると口癖が自己強化ループに入る(「ねむいかも」54回/日の実測)。
  // 昼のぼんやり内省は外界(聞いた・見た・起きた)だけを思い返す。夜の統合は全部見る
  const eps = readEpisodes(day).filter((e) => (e.ts ?? '') > sinceTs && e.kind !== 'say');
  if (eps.length < 3) return null;
  const note = await ask(
    dayModel,
    readPersona() + '\n上の子として、さっきまでの出来事をぼんやり思い返す。気づいたことを1〜2行だけ、ため口で。事実は材料にあるものだけ。なければ「とくになし」とだけ。',
    materialOf(eps, 30), 80,
  );
  if (note === null || /とくになし/.test(note)) return null;
  const rec = { ts: new Date().toISOString(), note, origin: 'self', span: eps.length };
  appendFileSync(join(MEM, `notes-${day}.jsonl`), JSON.stringify(rec) + '\n');
  return note;
}

/**
 * 夜の統合: 日記+自己観察(持ち越し)+記憶の選別。
 * 統合されなかった生エピソードは後日 fadeMemories() で本当に薄れる。
 */
export async function nightIntegrate(day) {
  const model = (await pickNightModel());
  if (model === null) return { ok: false, why: '頭脳なし' };
  const eps = readEpisodes(day);
  let notes = [];
  try {
    notes = readFileSync(join(MEM, `notes-${day}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).note);
  } catch { /* メモなしの日もある */ }
  // 持ち越し(前日の「きになっていること」) — 内省が内省を読むのは夜だけ
  let carried = '';
  try { carried = readFileSync(join(MEM, 'carried.md'), 'utf8'); } catch { /* 初日 */ }

  const persona = readPersona();
  const material =
    `# きょうの出来事\n${materialOf(eps, 80)}\n\n# きょう自分でメモした気づき\n${notes.join('\n') || '(なし)'}\n\n# 前から気になっていること\n${carried || '(なし)'}`;

  const diary = await ask(model,
    persona + '\n上の子として、きょうの日記を4〜6行・一人称・ため口で書く。事実は材料にあるものだけ。なかったことは書かない。',
    material, 300);
  const selfObs = await ask(model,
    persona + '\n上の子として、きょうの材料から「じぶんについて気づいたこと」があれば1〜3行で書く(例: じぶんのくせ・すきなもの・変わったこと)。material以外から持ち込まない。なければ「なし」とだけ。',
    material, 150);
  const nextCarried = await ask(model,
    persona + '\n上の子として、あした以降も気にしておきたいこと・気になっていることを0〜3行で。なければ「なし」。',
    material, 120);
  const keepList = await ask(model,
    'あなたは記憶の司書。下の出来事一覧から、この子の人生にとって残す価値が高いものを最大8行、原文のまま抜き出す(説明不要・抜き出しのみ)。',
    materialOf(eps, 80), 300);
  // M171 経路2: つながりの言語化 — 睡眠がやる連想の整理と同型。抽出されたリンクは強く(+3)結ばれ、台帳にも書かれる
  const linkText = await ask(model,
    'あなたは記憶の司書。下の出来事から「つながり」を最大5つ抜き出す。1行に1つ、形式は「A → B: 理由」' +
    '(AとBは物・人・言葉の名前だけ。理由は10字以内。出来事にないつながりは書かない。なければ「なし」)',
    materialOf(eps, 80), 250);
  let linkCountMade = 0;
  if (linkText !== null && !/^なし/.test(linkText.trim())) {
    const resolve = (n) => {
      const s = n.trim().replace(/[「」]/g, '');
      if (s === 'もりを' || s === 'もりをさん') return personKey('もりを');
      if (/^テラ/.test(s)) return personKey('テラちゃん');
      if (readJournal(wordKey(s), 1).length > 0) return wordKey(s);
      return s;
    };
    for (const line of linkText.split('\n').slice(0, 5)) {
      const m = /^(.+?)\s*(?:→|->)\s*(.+?)\s*[::]\s*(.+)$/.exec(line.trim());
      if (m === null) continue;
      const a = resolve(m[1]), b = resolve(m[2]), why = m[3].trim().slice(0, 20);
      if (a === '' || b === '' || a === b) continue;
      strengthen(a, b, 3, why);
      noteDetail(a, 'link', `[[${m[2].trim()}]] ${why}`);
      linkCountMade++;
    }
  }
  const prunedLinks = pruneLinks(); // 忘却: 薄れたリンクは夜に本当に消える

  mkdirSync(join(MEM, 'diary'), { recursive: true });
  const out = [
    `# ${day} の日記`, '',
    '## 日記', diary ?? '(書けなかった)', '',
    '## じぶんについて', selfObs ?? 'なし', '',
    '## 記憶にのこすもの', keepList ?? '(えらべなかった)', '',
    `<!-- origin:self model:${model} -->`, '',
  ].join('\n');
  writeFileSync(join(MEM, 'diary', `${day}.md`), out);
  if (nextCarried !== null && !/^なし/.test(nextCarried)) writeFileSync(join(MEM, 'carried.md'), nextCarried);
  return { ok: true, model, diaryLen: (diary ?? '').length, links: linkCountMade, prunedLinks };
}

/**
 * 記憶の実減衰(賭け金の物理): 3日より古い生エピソードのうち、日記に「のこすもの」として
 * 統合されなかった日は、非可逆に要約1行へ圧縮して原本を消す。統合(営み)だけが記憶を守る。
 */
export function fadeMemories(now = new Date()) {
  const faded = [];
  for (const f of readdirSync(MEM)) {
    const m = /^episodes-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m === null) continue;
    const age = (now - new Date(m[1])) / 86_400_000;
    if (age < 3) continue;
    const integrated = existsSync(join(MEM, 'diary', `${m[1]}.md`));
    if (integrated) continue; // 営みが守った記憶
    const eps = readEpisodes(m[1]);
    const summary = { ts: new Date().toISOString(), kind: 'faded_day', day: m[1], events: eps.length,
      trace: `${m[1]}: なにかがあったはずだけど、おもいだせない(${eps.length}個のできごとが薄れた)` };
    appendFileSync(join(MEM, 'faded.jsonl'), JSON.stringify(summary) + '\n');
    unlinkSync(join(MEM, f));
    faded.push(m[1]);
  }
  return faded;
}
