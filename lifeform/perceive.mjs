/**
 * 深い知覚(b案・M165)。「現実世界同等の情報量」の再現:
 * 情報量の本質は保存されたデータ量ではなく、①深さ(問うほど細部が湧く) ②変化(時間で変わる)
 * ③一貫性(昨日の世界と矛盾しない)。そこで知覚を「関数」にする —
 *   perceive(物, 注意の深さ, 時刻) → その場で生成される、過去と矛盾しない新しい細部
 * 錨(デタラメ防止): 実スクリーンショット(look)・建築仕様(shape/label)・観察台帳(過去の全細部)。
 * 台帳は lifeform/memory/objects/<name>.jsonl に永続し、世界は二度と自分と矛盾しない。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookAtWorld } from './eyes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBJ_DIR = join(HERE, 'memory', 'objects');

const safe = (name) => name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

// ---- M194: 五感 ----
// 物の感覚プロファイル=「世界の真実」(彼女の心ではなく世界側の設定)。
// 本来はテラが建築時に付与するのが正しい姿。当面は「世界の手ざわりを答える係」
// (=世界側のシミュレータ)が初対面時に一度だけ決めて、ここに永続する。
// 五感=5つ(ゆれ・動きは独立した感覚ではなく、見た目や手ざわりを通して感じる=説明側に書く)
export const SENSES = {
  sight: '見た目', sound: '音', touch: '手ざわり・温度', smell: 'におい', taste: 'あじ',
};
const PROFILE_PATH = join(HERE, 'memory', 'world-sense.json');
let profileCache = null;
function loadProfiles() {
  if (profileCache !== null) return profileCache;
  try { profileCache = JSON.parse(readFileSync(PROFILE_PATH, 'utf8')); } catch { profileCache = {}; }
  return profileCache;
}
function saveProfiles() {
  try { writeFileSync(PROFILE_PATH, JSON.stringify(profileCache, null, 1)); } catch { /* noop */ }
}
// 各感覚 = { v: 強さ0〜1, desc: その感覚での特徴(世界の定義)}。
// 強さ=その感覚で細部が残りやすいか(見た目のよいバイクはsightが高く、見た目の説明が残りやすい)
const DEFAULT_PROFILE = {
  sight: { v: 0.7, desc: '' }, sound: { v: 0.2, desc: '' }, touch: { v: 0.5, desc: '' },
  smell: { v: 0.2, desc: '' }, taste: { v: 0, desc: '' },
};
const normEntry = (raw) => {
  if (typeof raw === 'number') return { v: Math.max(0, Math.min(1, raw)), desc: '' };
  if (raw !== null && typeof raw === 'object') {
    const v = Number(raw.v);
    return { v: Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0, desc: String(raw.desc ?? '').slice(0, 60) };
  }
  return null;
};

/** M194b: 世界(テラの建築・世界サーバ)から届いた真実のプロファイルを取り込む */
export function adoptSenseProfile(name, rawProfile) {
  if (rawProfile === null || typeof rawProfile !== 'object') return false;
  const profile = {};
  for (const k of Object.keys(SENSES)) {
    const e = normEntry(rawProfile[k]);
    profile[k] = e ?? DEFAULT_PROFILE[k];
  }
  const all = loadProfiles();
  if (JSON.stringify(all[name]) === JSON.stringify(profile)) return false;
  all[name] = profile;
  saveProfiles();
  return true;
}

/** 世界側が物の感じられ方を一度だけ決める(あじは口にできる物だけ>0) */
export async function ensureSenseProfile(brainModel, name, spec = '', shownName = undefined) {
  const all = loadProfiles();
  if (all[name] !== undefined) return all[name];
  const disp = shownName ?? name;
  const profile = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: brainModel, stream: false, keep_alive: '3h', think: false,
        options: { temperature: 0.3, num_predict: 300 },
        messages: [{
          role: 'user',
          content: `あなたは3D世界の造り主の助手。物「${disp}」${spec !== '' ? `(かたち: ${spec})` : ''}の` +
            '五感プロファイル(この物が各感覚でどれくらい・どのように感じられるかの世界の定義)を決める。' +
            'JSONだけを返す。vは強さ0〜1、descはその感覚での特徴を日本語で一言(強さ0なら空文字): ' +
            '{"sight":{"v":0,"desc":"見た目"},"sound":{"v":0,"desc":"音"},"touch":{"v":0,"desc":"手ざわりや温度(ゆれ・動きもここ)"},' +
            '"smell":{"v":0,"desc":"におい"},"taste":{"v":0,"desc":"あじ"}}。tasteは口にできる物だけ0より大きくする。',
        }],
      }),
      signal: AbortSignal.timeout(90_000), // 物ごとに一度きり=コールドスタートを待ってよい
    });
    if (res.ok) {
      const raw = ((await res.json()).message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '');
      const m = /\{[\s\S]*\}/.exec(raw);
      if (m !== null) {
        const p = JSON.parse(m[0]);
        for (const k of Object.keys(SENSES)) {
          const e = normEntry(p[k]);
          if (e !== null) profile[k] = e;
        }
      }
    }
  } catch { /* 既定値で続行 */ }
  all[name] = profile;
  saveProfiles();
  return profile;
}

/** 物×感覚ごとの発見数(感覚別の井戸の水位) */
export function senseCountsOf(name) {
  const counts = {};
  for (const e of readJournal(name, 50)) {
    if (typeof e.sense === 'string') counts[e.sense] = (counts[e.sense] ?? 0) + 1;
  }
  return counts;
}

/**
 * 感覚の選択 — 命令ではなく重み付き抽選。
 * 重み = 物の性質(世界の真実) × 彼女の感度(経験で育つ) × 感覚別の新規度(涸れた井戸は軽い)。
 * 涸れた感覚の重みが下がることで「見飽きたら触る」が報酬勾配から自然に出る
 */
export function chooseSense(profile, sensitivity, counts) {
  const weights = [];
  for (const k of Object.keys(SENSES)) {
    const p = normEntry(profile?.[k]) ?? DEFAULT_PROFILE[k];
    if (p.v <= 0.05) continue;
    const sens = sensitivity?.[k] ?? 0.5;
    const nov = 10 / (10 + (counts?.[k] ?? 0) * 5); // 感覚の井戸は物全体より浅い(2個で半減)
    weights.push([k, p.v * sens * nov]);
  }
  if (weights.length === 0) return 'sight';
  const total = weights.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of weights) { r -= w; if (r <= 0) return k; }
  return weights[weights.length - 1][0];
}

export function readJournal(name, limit = 12) {
  const f = join(OBJ_DIR, `${safe(name)}.jsonl`);
  if (!existsSync(f)) return [];
  try {
    return readFileSync(f, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-limit);
  } catch { return []; }
}

function appendJournal(name, entry) {
  mkdirSync(OBJ_DIR, { recursive: true });
  appendFileSync(join(OBJ_DIR, `${safe(name)}.jsonl`), JSON.stringify(entry) + '\n');
}

/** 注意の深さ。深いほど行動コストが高く、返る情報の様式が変わる */
export const LEVELS = {
  look: 'とおくから見た',       // 視覚(実スクショ→視覚モデル)。コスト0
  approach: 'ちかくでよく見た', // 歩いて近寄る(歩行コスト)
  touch: 'さわってみた',        // 手ざわり・温度・重さの気配(体力小)
  stay: 'そばでしばらく過ごした', // 時間変化(音・光・ゆらぎ)
};

const tod = () => { const h = new Date().getHours(); return h < 5 ? 'まよなか' : h < 10 ? 'あさ' : h < 17 ? 'おひる' : h < 22 ? 'ゆうがた' : 'よる'; };

/**
 * 深い知覚の本体。1回の知覚=新しい細部1つ。台帳に永続し、既知の細部とは矛盾しない。
 * @returns {Promise<string|null>} 新しく知覚された細部(1文)
 */
export async function perceive(brainModel, { name, spec = '', level, sensitivity = null, links = [], label = undefined }) {
  const journal = readJournal(name, 20);
  const known = journal.map((j) => `- ${j.detail}`).join('\n');
  // M198: labelは言葉の上での呼び名(台帳・プロファイルはnameのまま)。ひとの個体キーを文章に漏らさない
  const shown = label ?? name;

  // look は実画面が錨(画素の真実)。それ以外は仕様+台帳の範囲でその場に細部が「ある」ことにする
  if (level === 'look') {
    const seen = await lookAtWorld(
      `この3D世界の画面に「${shown}」${spec !== '' ? `(${spec})` : ''}という物があります。その見た目を、子どもが言うみたいに日本語で短く1文だけ。`);
    if (seen === null) return null;
    // M181: 台帳への記帳は呼び出し側(noteDetail)に一元化 — 学び/再現の判定を先にできるように
    return { text: seen, sense: 'sight' };
  }

  // M194: 世界の真実(プロファイル)×彼女の感度×感覚別の井戸で、今回ひらく感覚を抽選
  const profile = await ensureSenseProfile(brainModel, name, spec, shown);
  const sense = chooseSense(profile, sensitivity, senseCountsOf(name));
  const profileLine = Object.keys(SENSES)
    .map((k) => `${SENSES[k]}${(normEntry(profile[k])?.v ?? 0).toFixed(1)}`)
    .join(' ');
  const senseDef = normEntry(profile[sense])?.desc ?? '';
  // M194: リンクのレンズ — つながっている記憶を提示するだけ(使い方は指示しない)
  const linkLine = links.length > 0
    ? `この物とつながっている記憶: ${links.map((l) => l.note !== undefined && l.note !== '' ? `${l.other}(${String(l.note).slice(0, 20)})` : l.other).join('、')}\n`
    : '';

  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: brainModel, stream: false, keep_alive: '3h', think: false,
        options: { temperature: 0.9, num_predict: 60 },
        messages: [{
          role: 'user',
          content: `あなたは世界の手ざわりを答える係。3D世界の物「${shown}」${spec !== '' ? `(かたち: ${spec})` : ''}。\n` +
            `この物の感じられ方(世界のきまり・強さ0〜1): ${profileLine}\n` +
            (known !== '' ? `これまでに知られていること:\n${known}\n` : '') +
            linkLine +
            `いまは${tod()}。この物を「${LEVELS[level] ?? level}」。\n` +
            (senseDef !== '' ? `世界の定義: この物の${SENSES[sense]}は「${senseDef}」。\n` : '') +
            `知られていること・世界の定義と矛盾しない、あたらしい細部を1つだけ、子どもにわかる言葉で1文で。` +
            `とくに「${SENSES[sense]}」のことを具体的に。前置きなしで細部だけ。`,
        }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    let text = ((await res.json()).message?.content ?? '').trim().replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    text = text.split('\n')[0].slice(0, 90);
    if (text === '') return null;
    // M181: 記帳は呼び出し側に一元化(noteDetail)
    return { text, sense };
  } catch { return null; }
}

/** M170: 言葉も好奇心の対象(台帳の名前空間はことば:) / M171: ひとの台帳(ひと:) */
export const wordKey = (w) => `ことば:${w}`;
export const personKey = (p) => `ひと:${p}`;
/** 表示用: 名前空間の接頭辞を剥がす */
export const plainName = (n) => n.replace(/^(ことば|ひと):/, '');
export function knownWords() {
  try {
    return readdirSync(OBJ_DIR)
      .filter((f) => f.startsWith('ことば_') && f.endsWith('.jsonl'))
      .map((f) => f.slice('ことば_'.length, -'.jsonl'.length));
  } catch { return []; }
}

/** M181: 既知照合 — 「予測できるものは学びではない」。正規化して台帳と比較する */
const normalizeDetail = (s) => String(s).replace(/[「」。、!?…✨🌙☀️\s]/gu, '').slice(0, 60);
export function isKnownDetail(name, detail) {
  const n = normalizeDetail(detail);
  if (n === '') return true;
  for (const e of readJournal(name, 50)) {
    const k = normalizeDetail(e.detail);
    if (k === n || (k.length > 10 && (k.includes(n) || n.includes(k)))) return true;
  }
  return false;
}

/** 外から観測した細部を台帳に記す(アプリ操作の反応など、生成ではなく実測の知覚) */
export function noteDetail(name, level, detail, sense = undefined) {
  const entry = { ts: new Date().toISOString(), level, tod: tod(), detail: String(detail).slice(0, 120) };
  if (typeof sense === 'string') entry.sense = sense; // M194: 感覚別の井戸の水位に使う
  appendJournal(name, entry);
}

/** 会話・内省用: この物について知っていることの要約(狭い帯域に収まる形) */
export function knownAbout(name, limit = 3) {
  const j = readJournal(name, limit);
  if (j.length === 0) return '';
  return j.map((e) => e.detail).join('/');
}

/** 好奇心の対象選び: 台帳が薄い・古い物ほど「まだ学べること」が多い */
export function noveltyOf(name) {
  const j = readJournal(name, 50);
  if (j.length === 0) return 1;
  const ageDays = (Date.now() - new Date(j[j.length - 1].ts).getTime()) / 86_400_000;
  // 細部10個で半減+3日触れないと戻る(世界は変わるので「知り尽くした」は永続しない)
  return Math.min(1, 10 / (10 + j.length) + Math.min(0.4, ageDays * 0.13));
}
