/**
 * 深い知覚(b案・M165)。「現実世界同等の情報量」の再現:
 * 情報量の本質は保存されたデータ量ではなく、①深さ(問うほど細部が湧く) ②変化(時間で変わる)
 * ③一貫性(昨日の世界と矛盾しない)。そこで知覚を「関数」にする —
 *   perceive(物, 注意の深さ, 時刻) → その場で生成される、過去と矛盾しない新しい細部
 * 錨(デタラメ防止): 実スクリーンショット(look)・建築仕様(shape/label)・観察台帳(過去の全細部)。
 * 台帳は lifeform/memory/objects/<name>.jsonl に永続し、世界は二度と自分と矛盾しない。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookAtWorld } from './eyes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBJ_DIR = join(HERE, 'memory', 'objects');

const safe = (name) => name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

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
export async function perceive(brainModel, { name, spec = '', level }) {
  const journal = readJournal(name, 20);
  const known = journal.map((j) => `- ${j.detail}`).join('\n');

  // look は実画面が錨(画素の真実)。それ以外は仕様+台帳の範囲でその場に細部が「ある」ことにする
  if (level === 'look') {
    const seen = await lookAtWorld(
      `この3D世界の画面に「${name}」${spec !== '' ? `(${spec})` : ''}という物があります。その見た目を、子どもが言うみたいに日本語で短く1文だけ。`);
    if (seen === null) return null;
    // M181: 台帳への記帳は呼び出し側(noteDetail)に一元化 — 学び/再現の判定を先にできるように
    return seen;
  }

  try {
    const res = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: brainModel, stream: false, keep_alive: '3h', think: false,
        options: { temperature: 0.9, num_predict: 60 },
        messages: [{
          role: 'user',
          content: `あなたは世界の手ざわりを答える係。3D世界の物「${name}」${spec !== '' ? `(かたち: ${spec})` : ''}。\n` +
            (known !== '' ? `これまでに知られていること:\n${known}\n` : '') +
            `いまは${tod()}。この物を「${LEVELS[level] ?? level}」。\n` +
            '知られていることと矛盾しない、あたらしい細部を1つだけ、子どもにわかる言葉で1文で。' +
            '感覚(見た目・音・手ざわり・温度・におい・ゆれ)のどれかを具体的に。前置きなしで細部だけ。',
        }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) return null;
    let text = ((await res.json()).message?.content ?? '').trim().replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    text = text.split('\n')[0].slice(0, 90);
    if (text === '') return null;
    // M181: 記帳は呼び出し側に一元化(noteDetail)
    return text;
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
export function noteDetail(name, level, detail) {
  appendJournal(name, { ts: new Date().toISOString(), level, tod: tod(), detail: String(detail).slice(0, 120) });
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
