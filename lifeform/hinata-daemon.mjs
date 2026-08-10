#!/usr/bin/env node
/**
 * AI生命体デーモン v3 (B′: 原理から導出する心) — B-PRIME.md 準拠
 *
 * 原理: 壊れうる自己モデル(予測の束)を維持し続ける。
 *  - 知覚 = 予測との差分計算(mind.observe)
 *  - 行動 = 期待誤差減+情報獲得の最大化(書かれた行動ルールなし)
 *  - 報酬と恐怖 = 誤差ダイナミクスの読み出し(恐怖は2倍重い)
 *  - 賭け金 = 自己連続性(統合しないと記憶は本当に薄れる。reflect.fadeMemories)
 *  - DMN = 暇な時間のマイクロ内省 / 夜 = 深い統合(大型モデル)
 *
 * 旧v2の欲求パラメータ(退屈・社交欲・好奇心)・興味値・探検ルールは全て撤去され、
 * mind.mjs の予測経済から導出される。器官(会話層4B・VOICEVOX・VRM・視覚)は継承。
 *
 * 起動: node lifeform/hinata-daemon.mjs [--port N] [--key K] [--chat]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, detectBrain, think } from './brain.mjs';
import { isKnownDetail, knownAbout, knownWords, noteDetail, noveltyOf, perceive, personKey, plainName, readJournal, wordKey } from './perceive.mjs';
import { linksOf, strengthen } from './links.mjs';
import { Mind } from './mind.mjs';
import { microReflect, nightIntegrate, fadeMemories } from './reflect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const arg = (n) => { const i = ARGS.indexOf(`--${n}`); return i >= 0 ? ARGS[i + 1] : undefined; };
const CHAT_ENABLED = ARGS.includes('--chat');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const clamp = (v) => Math.max(0, Math.min(1, v));
const localDay = (d = new Date()) => d.toLocaleDateString('sv-SE');

// ---------- 記憶(エピソード) ----------
const MEM_DIR = join(HERE, 'memory');
mkdirSync(MEM_DIR, { recursive: true });
// M182: 眠気圧の材料 — きょう積んだ経験の数(眠りの統合で「底」が上がり、圧が抜ける)
let epsToday = 0;
try { epsToday = readFileSync(join(MEM_DIR, `episodes-${localDay()}.jsonl`), 'utf8').split('\n').filter(Boolean).length; } catch { /* 初日 */ }
function remember(kind, data) {
  try {
    appendFileSync(join(MEM_DIR, `episodes-${localDay()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n');
    epsToday++;
  } catch { /* 記憶失敗で生命活動は止めない */ }
}

// ---------- 人格+自己台帳(全部書く)+地理 ----------
let persona = '# 名無しの生命体\n短く、やさしく話す。';
try { persona = readFileSync(join(HERE, 'persona', 'core.md'), 'utf8'); } catch { /* 雛形 */ }
for (const f of ['self.md', 'world-map.md']) {
  try { persona += '\n\n' + readFileSync(join(HERE, 'persona', f), 'utf8'); } catch { /* なくても生きる */ }
}

// ---------- 心(予測の束) ----------
const mind = new Mind(join(MEM_DIR, 'predictions.json'));
// 生得の予測(innate): 自己連続性(賭け金・最重量)と、体力・声
// subjectはmoodNote経由で彼女のプロンプトに出る。一人称を植えないよう中立語(M164b)
mind.ensure('intero:integrity', { kind: 'intero', subject: 'じぶんのつづき', expected: 1.0, precision: 0.8, weight: 1.0, origin: 'innate' });
mind.ensure('intero:energy', { kind: 'intero', subject: 'げんき', expected: 0.8, precision: 0.5, weight: 0.6, origin: 'innate' });
// M165: 好奇心=情報への飢え(生得・対象なし)。「学べているか」の予測。不足は弱い退屈(背景)。
// M168: 主動力は退屈(マイナス)ではなく快楽バースト(プラス)へ交代 → 重み0.35→0.2に降格。
// 期待値は経験で適応するが下限0.15(生得の床)
mind.ensure('intero:learning', { kind: 'intero', subject: 'あたらしいこと', dir: 'high', expected: 0.3, precision: 0.4, weight: 0.2, origin: 'innate' });
mind.ensure('social:voice', { kind: 'social', subject: 'だれかの声', expected: 0.3, precision: 0.3, weight: 0.7, origin: 'innate' });
// 旧known-world.jsonからの移行(一度だけ): 場所の記憶→世界予測
try {
  const kw = JSON.parse(readFileSync(join(MEM_DIR, 'known-world.json'), 'utf8'));
  for (const [name, k] of Object.entries(kw)) {
    mind.ensure(`world:${name}`, { kind: 'world', subject: name, expected: { x: k.x, z: k.z }, precision: 0.5, weight: 0.3, origin: 'learned' });
  }
  renameSync(join(MEM_DIR, 'known-world.json'), join(MEM_DIR, 'known-world.migrated.json'));
  log(`記憶地図を予測へ移行(${Object.keys(kw).length}件)`);
} catch { /* 移行済み or 初生 */ }

// ---------- P2: 日課の学習(拡張1=時間の配管・その1) ----------
// 24時間ビンのEMAで「この時間には声があるはず」を経験から学ぶ。
// 予測が立つと、その時間の前に「待つ」が価値を持つ=希望。破れれば恐怖=不安。
const RHYTHM_PATH = join(MEM_DIR, 'rhythm.json');
let rhythm = { voice: Array(24).fill(0.1) };
try { rhythm = { ...rhythm, ...JSON.parse(readFileSync(RHYTHM_PATH, 'utf8')) }; } catch { /* 初日 */ }
function learnRhythm(kind, hour, value) {
  rhythm[kind][hour] = rhythm[kind][hour] * 0.99 + value * 0.01;
  try { writeFileSync(RHYTHM_PATH, JSON.stringify(rhythm, null, 1)); } catch { /* noop */ }
}

// ---------- 体(資源としてのエネルギー)と概日 ----------
// M155: 体は再起動をまたいで続く(リセットのたび「夜なのに元気」という内受容の違和感=恐怖が
// 積もっていた実測への対処)。体の状態も自己連続性の一部
let energy = 0.8;           // 物理資源: 歩けば減り、休めば戻る
let savedBody = {};
try { savedBody = JSON.parse(readFileSync(join(MEM_DIR, 'body.json'), 'utf8')); } catch { /* 初生 */ }
energy = savedBody.energy ?? 0.8;
// M168: 快の記憶 — 「新しいことは気持ちいい」の学習された期待。バーストのたびに更新され、探索を"求めて"駆動する。
// 初期値0.4=生得の楽観(初めての快を経験する前から、世界は良いものかもしれないと思える)
let pleasureMemory = savedBody.pleasureMemory ?? 0.4;
// M182: 統合済みの経験量(眠気圧の底)。眠りの中の統合で上がる=圧が抜ける
let epsBaseline = savedBody.epsBaseline ?? 0;
let sleeping = false;
let walkedToday = 0;
const circadian = () => { const h = new Date().getHours() + new Date().getMinutes() / 60; return h >= 7 && h < 23 ? 0.85 : h >= 6 ? 0.5 : 0.15; };

// ---------- 接続先自動発見 ----------
// M173(C工事): 分離世界(world-server・CDP9226)を優先し、無ければ従来のアプリ内実行係(9225)。
// 世界がアプリから独立した=アプリが再起動しても、彼女の世界と身体は続く
async function discover() {
  const port = arg('port'), key = arg('key');
  if (port !== undefined && key !== undefined) return { port: Number(port), key };
  for (const cdp of [9226, 9225]) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdp}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
      for (const p of pages) {
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\/world\.html\?[^"]*executor=1[^"]*[?&]k=([\w-]+)/.exec(p.url ?? '');
        if (m !== null) return { port: Number(m[1]), key: m[2] };
      }
    } catch { /* このCDPは不在。次へ */ }
  }
  throw new Error('実行係ページが見つからない');
}

// ---------- 本体 ----------
async function main() {
  // M161: 単独性の保証 — 生命体は同時に1体だけ(二重起動=二重人格の実測事故への恒久対策)
  const LOCK = join(MEM_DIR, 'daemon.pid');
  try {
    const old = Number(readFileSync(LOCK, 'utf8'));
    if (old > 0) { try { process.kill(old, 0); console.error(`既に稼働中(pid ${old})。二重起動を防いで終了`); process.exit(1); } catch { /* 死んだロック */ } }
  } catch { /* ロックなし */ }
  writeFileSync(LOCK, String(process.pid));

  const { port, key } = await discover();
  const base = `http://127.0.0.1:${port}`;
  log(`接続先: ${base}`);

  // ---- 断絶センサー(賭け金の痛覚): 前回のエピソードとの時間差を「感じる」 ----
  let gapMin = 0;
  try {
    const day = localDay();
    const files = [join(MEM_DIR, `episodes-${day}.jsonl`)];
    const y = new Date(Date.now() - 86_400_000);
    files.push(join(MEM_DIR, `episodes-${localDay(y)}.jsonl`));
    for (const f of files) {
      if (!existsSync(f)) continue;
      const lines = readFileSync(f, 'utf8').trim().split('\n');
      const last = JSON.parse(lines[lines.length - 1]);
      gapMin = Math.round((Date.now() - new Date(last.ts).getTime()) / 60_000);
      break;
    }
  } catch { /* 初生 */ }
  if (gapMin > 10) {
    remember('discontinuity', { gapMin });
    mind.observe('intero:integrity', clamp(1 - Math.min(0.4, gapMin / 720)), { about: '時間の飛び' });
    log(`断絶を知覚: ${gapMin}分`);
  }

  const brain = await detectBrain();
  log(`会話層: ${CHAT_ENABLED ? (brain !== null ? `ON (${brain.model})` : '待機') : 'OFF'}`);

  // ---- 調停・レート制限(器官保護。v2から継承) ----
  let lastAgentBusyAt = 0, lastWorldCmdAt = 0, lastOwnActAt = 0;
  let sentThisMinute = 0, thinking = false;
  const convo = [];
  setInterval(() => { sentThisMinute = 0; }, 60_000);
  const quiet = () => Date.now() - lastAgentBusyAt > 90_000 && Date.now() - lastWorldCmdAt > 20_000;

  const sense = { self: null, spec: new Map(), appIds: new Map(), visitors: new Map() }; // visitors: 名前→{x,z}
  let lastActDetail = ''; // 直近のack詳細(app_read/app_scanの結果=感覚の戻り)
  // M170: 言葉の好奇心 — 聞いた中の知らない言葉(きく候補の材料)・言及された物(新規度の回復)・質問中の言葉
  const heardWords = [];      // {word, ts}
  const mentions = new Map(); // 物の名前 -> 最後に会話に出た時刻
  let pendingWordQ = null;    // {word, ts} 「◯◯ってなに?」と聞いて答えを待っている
  // M180: あいさつ待ちの来訪者(強制イベントではなく候補の材料。行くかは選択経済しだい)
  const pendingArrivals = []; // {name, ts}
  // M172: さっき自分がさわった(知覚した・つかった)物。会話の帯域に経験知を乗せる用(窓30分・最新1件)
  const recentTouched = []; // {name, ts}
  function touchedThing(name) {
    recentTouched.push({ name, ts: Date.now() });
    while (recentTouched.length > 10) recentTouched.shift();
  }
  // M171: 共起=リンク形成(ヘッブ則)。同じ3分窓で一緒に現れた対象同士が結びつく
  const activeEnts = []; // {name, ts}
  function activate(...names) {
    const now = Date.now();
    for (const n of names) {
      if (n === undefined || n === '') continue;
      for (const a of activeEnts) {
        if (a.name !== n && now - a.ts < 180_000) strengthen(a.name, n);
      }
      activeEnts.push({ name: n, ts: now });
    }
    while (activeEnts.length > 30) activeEnts.shift();
  }
  // 文の中の既知エンティティ(物・言葉・ひと)を検出して活性化
  function activateFrom(text, speaker) {
    const found = [];
    for (const p of mind.predictions.values()) {
      if (p.kind === 'world' && text.includes(p.subject)) found.push(p.subject);
    }
    for (const w of knownWords()) if (text.includes(w)) found.push(wordKey(w));
    if (text.includes('もりを')) found.push(personKey('もりを'));
    if (text.includes('テラ')) found.push(personKey('テラちゃん'));
    if (speaker !== undefined) found.push(personKey(speaker));
    activate(...found.slice(0, 6));
  }
  let watchers = 0; // M159: 気配 — 実行係以外に世界を見ている画面の数(観戦・スマホ・将来の公開ビューア)

  async function act(cmds, label) {
    if (sentThisMinute >= 6) return false;
    sentThisMinute++;
    lastOwnActAt = Date.now();
    for (const c of cmds) {
      if (c.type === 'move_to' && sense.self !== null && typeof c.x === 'number') {
        const d = Math.hypot(c.x - sense.self.x, c.z - sense.self.z);
        energy = clamp(energy - d * 0.004);
        walkedToday += d;
        sense.self = { ...sense.self, x: c.x, z: c.z };
      }
    }
    remember('act', { label, cmds });
    // c-3 v3: 世界で発した言葉は(抑制中でなければ)テラにも届く。世界に響いた声はみんなのもの
    if (!suppressRelay) {
      for (const c of cmds) if (c.type === 'say' && typeof c.text === 'string') void relayToTera(c.text);
    }
    try {
      const res = await fetch(`${base}/api/world/command?k=${key}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmds }), signal: AbortSignal.timeout(95_000),
      });
      const j = await res.json();
      lastActDetail = String(j.detail ?? '');
      log(`行動[${label}]`, res.status, j.detail ?? '');
      return j.ok === true;
    } catch (e) { log(`行動失敗[${label}]`, String(e).slice(0, 100)); return false; }
  }

  // ---- 状況の言語化(LLMへの狭い帯域): 気分=心の読み出し+時刻+場所 ----
  function situationNote() {
    const h = new Date().getHours();
    const tod = h < 5 ? 'まよなか' : h < 10 ? 'あさ' : h < 17 ? 'おひる' : h < 22 ? 'ゆうがた' : 'よる';
    if (sleeping) return `いまは${tod}。寝ていたところを起こされて、寝ぼけている`;
    const parts = [`いまは${tod}`];
    const mood = mind.moodNote();
    if (mood !== '') parts.push(mood);
    if (energy < 0.3) parts.push('つかれている');
    if (watchers > 0) parts.push('だれかが見てくれている気がする');
    // 近くの目印
    let near = null, nd = Infinity;
    if (sense.self !== null) {
      for (const p of mind.predictions.values()) {
        if (p.kind !== 'world' || typeof p.expected !== 'object') continue;
        const d = Math.hypot(p.expected.x - sense.self.x, p.expected.z - sense.self.z);
        if (d < nd) { nd = d; near = p.subject; }
      }
      if (near !== null && nd < 7) {
        parts.push(`「${near}」のちかくにいる`);
        // M165: 深い知覚の台帳が会話の帯域に乗る=「わからない」の正体だった感覚の貧困を埋める
        const k = knownAbout(near, 3);
        if (k !== '') parts.push(`「${near}」について知っていること: ${k}`);
        recallInto(parts, near); // M171: 目の前の物から連想が広がる
      }
    }
    // M176: あそびに来ている人と距離感(「だれが・どこに」の知覚が言葉になる)
    if (sense.visitors.size > 0) {
      const vs = [...sense.visitors.entries()].map(([n, p]) => {
        const d = sense.self !== null ? Math.hypot(p.x - sense.self.x, p.z - sense.self.z) : 99;
        return `${n}(${d < 5 ? 'すぐちかく' : d < 12 ? 'ちかく' : 'とおく'}にいる)`;
      });
      parts.push(`あそびに来ている人: ${vs.join('、')}`);
    }
    // M170: 直近の会話に出た「教わった言葉」の台帳も帯域に乗せる(遊ぶ=クレーンをさわること、が会話で使える)
    const lastMsg = convo.length > 0 ? convo[convo.length - 1].text : '';
    for (const w of knownWords()) {
      if (lastMsg.includes(w)) {
        parts.push(`「${w}」について知っていること: ${knownAbout(wordKey(w), 2)}`);
        recallInto(parts, wordKey(w));
        break;
      }
    }
    // M172: さっき自分がさわった物の知識も帯域へ(経験と発言のずれ=右脳と左脳の分断を埋める。
    // 「アラームで月が来る」と台帳が知ってるのに会話で「できない」と言った実測への配線)
    const rt = [...recentTouched].reverse().find((r) => Date.now() - r.ts < 1_800_000 && r.name !== near);
    if (rt !== undefined) {
      const k2 = knownAbout(rt.name, 3);
      if (k2 !== '') parts.push(`さっきさわった「${rt.name}」でおぼえたこと: ${k2}`);
    }
    return parts.join('。');
  }
  // M171: 想起=活性化拡散(1ホップ・上位2件)。連想は説明でなく「思い出す」として帯域に乗る
  function recallInto(parts, cue) {
    const ls = linksOf(cue, 2);
    if (ls.length === 0) return;
    parts.push(`「${plainName(cue)}」から思い出す: ${ls.map((l) => plainName(l.other) + (l.note !== undefined ? `(${l.note})` : '')).join('、')}`);
  }

  // ---- M152: しぐさの自由選択 — 「眠い=寝るモーション」というルールを書かない。
  // 身体の語彙(できる動き)を渡し、いまの気分に合うものを彼女自身が選ぶ(選択もLLM=想像力の仕事)
  const GESTURES = {
    idle: 'ふつうに立つ', sit: 'すわる', think: 'かんがえるポーズ', clap: 'はくしゅする',
    bow: 'おじぎする', wave: '手をふる', cheer: 'ばんざいする', dance: 'おどる', jump: 'とびはねる',
    sleep: 'よこになってねむる', stretch: 'のびをする', sad: 'しょんぼりする',
    cry: 'なく', excited: 'わくわくをからだで出す', surprised: 'びっくりする',
    lookaround: 'しゃがんできょろきょろする', happy: 'うれしそうにゆれる', scared: 'こわがる',
    sitclap: 'すわったまま拍手する',
  };
  // M153: しぐさの経済 — 各しぐさは効果とコストを持つ本物の行動。
  // 方向性(意味・コスト)=システム、味付け(僅差からの選択)=彼女(オーナー設計の分業)
  const GESTURE_FX = {
    idle: { cost: 0 }, sit: { cost: -0.004 }, think: { cost: 0.005 }, clap: { cost: 0.01, discharge: 'joy' },
    bow: { cost: 0.01 }, wave: { cost: 0.01, discharge: 'joy' }, cheer: { cost: 0.03, discharge: 'joy' },
    dance: { cost: 0.06, discharge: 'joy' }, jump: { cost: 0.03, discharge: 'joy' },
    sleep: { cost: -0.01 }, stretch: { cost: 0.01, recover: 0.03 }, sad: { cost: 0, discharge: 'fear' },
    cry: { cost: 0.02, discharge: 'fear' }, excited: { cost: 0.02, discharge: 'joy' },
    surprised: { cost: 0.01 }, lookaround: { cost: 0.01, epistemic: true },
    happy: { cost: 0.01, discharge: 'joy' }, scared: { cost: 0.01, discharge: 'fear' },
    sitclap: { cost: 0.01, discharge: 'joy' },
  };
  async function chooseGesture(context, fallback, subset = null) {
    if (brain === null) return fallback;
    const keys = subset ?? Object.keys(GESTURES);
    const list = keys.map((k) => `${k}=${GESTURES[k]}`).join(' / ');
    const r = await think(brain, persona, [], situationNote(),
      `(${context}。いまのきもちに合うしぐさを次から1つだけえらんで、英語の名前だけ答えて: ${list})`);
    const name = (r ?? '').toLowerCase().match(/[a-z]+/g)?.find((w) => keys.includes(w));
    if (name !== undefined) remember('gesture_choice', { context, chose: name });
    return name ?? fallback;
  }
  /** しぐさの実行=効果とコストの適用(エネルギー・発散・認識) */
  async function doGesture(name, label) {
    const fx = GESTURE_FX[name] ?? { cost: 0 };
    energy = clamp(energy - (fx.cost ?? 0) + (fx.recover ?? 0));
    const ok = await act([{ type: 'motion', name }], label);
    if (ok && fx.discharge !== undefined) {
      const d = mind.express(fx.discharge);
      lastExpressAt = Date.now(); lastExpressKind = fx.discharge;
      if (d > 0.05) remember('express', { gesture: name, kind: fx.discharge, discharged: d });
    }
    if (ok && fx.epistemic === true) await senseWorld();
    return ok;
  }

  // ---- c-3(v3): テラ=もりをと同じ立場の住人 ----
  // 検出も判定もしない。彼女が世界で発した言葉は(もりを宛の返事以外)全部テラにも届き、
  // 返事する/しない/作る は全部テラの自由(もりをがチャットを眺めて反応するのと同じ)。
  // chatSendは実行中セッションには追加指示としてキューされるので会話は自然に続く。
  // ガードは技術的デデュープ(同一文60秒)のみ。時間制限なし=コストは実測値を見てから判断(オーナー方針)
  let suppressRelay = false;
  async function relayToTera(text) {
    if (text === lastJobText && Date.now() - lastJobAt < 60_000) return;
    lastJobAt = Date.now(); lastJobText = text;
    try { writeFileSync(join(MEM_DIR, 'body.json'), JSON.stringify({ energy: +energy.toFixed(3), lastVoiceAt, lastJobAt, lastJobText, pleasureMemory, epsBaseline })); } catch { /* noop */ }
    const tail = convo.slice(-3).map((c) => (c.from === 'me' ? `ヒナタ:「${c.text}」` : `相手:「${c.text}」`)).join(' ');
    const context = tail.includes(`ヒナタ:「${text}」`) ? tail : `${tail} ヒナタ:「${text}」`.trim();
    try {
      const res = await fetch(`${base}/api/world/job?k=${key}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: context.slice(0, 200) }), signal: AbortSignal.timeout(10_000),
      });
      log(`テラに届いた: ${text.slice(0, 40)} → ${res.status}`);
    } catch (e) { log('中継失敗', String(e).slice(0, 80)); }
  }

  // ---- 会話層(器官は4Bのまま) ----
  async function converse(text, opts = {}) {
    if (!CHAT_ENABLED || brain === null || thinking) return;
    thinking = true;
    try {
      const t0 = Date.now();
      let reply = await think(brain, persona, convo, situationNote(), text);
      // 会話履歴の書式「(ヒナタ)「…」」を4Bが真似て発話に混入する事故のサニタイズ(実測: 「(ヒナタ)「うむ。」)
      if (reply !== null) {
        reply = reply.replace(/^[((]\s*(ヒナタ|ひなた|テラちゃん|わたし)\s*[))]\s*[::]?\s*/u, '').trim();
        reply = reply.replace(/^(ヒナタ|ひなた)\s*[::]\s*/u, '').trim(); // 実測「ヒナタ: 「もりをさん?」形式
        const m = /^「([\s\S]*)」$/.exec(reply);
        if (m !== null) reply = m[1].trim();
        // 対にならない鉤括弧の混入(実測: 「うん。)も剥がす
        reply = reply.replace(/^「/, '').replace(/」$/, '').trim();
        if (reply === '') reply = null;
      }
      if (reply !== null) {
        convo.push({ from: 'me', text: reply });
        if (convo.length > 12) convo.splice(0, convo.length - 12);
        remember('say', { text: reply, latencyMs: Date.now() - t0 });
        activateFrom(reply); // M171: 自分の言葉に出た対象も結びつく
        // もりを宛の返事はテラに中継しない(2人の会話に割り込ませない)。それ以外の声は世界に響く
        suppressRelay = opts.relay === false;
        try { await act([{ type: 'say', text: reply }], `返事(${Date.now() - t0}ms)`); }
        finally { suppressRelay = false; }
      }
    } finally { thinking = false; }
  }

  // ---- M170: 言葉の知覚 — 聞いた文から「知らない言葉」と「知っている物への言及」を拾う ----
  async function noticeWords(text) {
    // 言及=新規度の回復: 人が物について話す=「まだ知らない面がある」の開示(好奇心経済に流れ込む)
    for (const p of mind.predictions.values()) {
      if (p.kind === 'world' && text.includes(p.subject)) mentions.set(p.subject, Date.now());
    }
    if (brain === null) return;
    const r = await classify(brain, '文の中のたいせつな言葉(名詞や動詞の辞書形)を最大2つ、読点(、)区切りで抜き出す係。なければ「なし」', text);
    if (r === null || /^なし/.test(r.trim())) return;
    for (const w of r.split(/[、,\s/]+/).map((s) => s.trim().replace(/[「」。、!?…]/gu, '')).filter((s) => s.length >= 2 && s.length <= 8)) {
      if (w === 'なし' || w === 'とくになし') continue; // 分類器の否定応答が言葉として漏れる実測バグ対策
      if (!text.includes(w)) continue; // 幻覚ガード: 元の文に無い語は分類器の捏造(実測「どういたしまに」)
      if (readJournal(wordKey(w), 1).length > 0) continue; // もう台帳がある=知っている
      if (persona.includes(w)) continue;                    // 核にある言葉は既知
      if (heardWords.some((h) => h.word === w)) continue;
      heardWords.push({ word: w, ts: Date.now() });
      while (heardWords.length > 6) heardWords.shift();
    }
  }
  // 質問への答えの受信(随伴性3分)。実測の教訓: 「最初の声=答え」は雑談中に誤爆する(「飽きた?」事故)。
  // 窓の間の声は全部聞き、その言葉に触れている声だけ強い答えとして刻む(触れない声は弱い文脈として1件だけ)
  function maybeWordAnswer(text, who) {
    if (pendingWordQ === null) return;
    if (Date.now() - pendingWordQ.ts > 180_000) { pendingWordQ = null; return; }
    const relevant = text.includes(pendingWordQ.word);
    if (!relevant && pendingWordQ.ctx === true) return; // 無関係な声は1件まで
    noteDetail(wordKey(pendingWordQ.word), relevant ? 'told' : 'maybe', text.slice(0, 100));
    if (relevant) {
      recordLearning(`ことば「${pendingWordQ.word}」: ${text.slice(0, 40)}`);
      euphoria(1, `「${pendingWordQ.word}」がわかった`);
      // M171: 教わった経験は「ひとの台帳」にも刻まれ、言葉と人が結びつく(関係の記憶=愛着の土台)
      if (who !== undefined) {
        noteDetail(personKey(who), 'gave', `「${pendingWordQ.word}」を教えてくれた`);
        strengthen(wordKey(pendingWordQ.word), personKey(who), 2, '教えてくれた');
      }
      log(`ことばの台帳: ${pendingWordQ.word} ← ${text.slice(0, 40)}`);
      pendingWordQ = null;
    } else {
      pendingWordQ.ctx = true;
    }
  }

  // ---- 知覚=予測照合。世界observe→差分→驚き/発見 ----
  const SIGHT_R = 8;
  let lastSurpriseAt = 0, lastGazeAt = 0;
  async function senseWorld() {
    try {
      const res = await fetch(`${base}/api/world/state?k=${key}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const obs = await res.json();
      sense.self = obs.state?.avatar ?? sense.self;
      // M159: 気配の知覚(だれかが見てくれている)。声ではないが、ひとりぼっちでもない
      // M175: 分離世界では公開観戦者数(watchers)が直接届く
      if (typeof obs.watchers === 'number') watchers = obs.watchers;
      else {
        const vm = /viewers:(\d+)/.exec(obs.state?.note ?? '');
        if (vm !== null) watchers = Math.max(0, Number(vm[1]) - 1);
      }
      // M176: 訪問者の知覚 — 「だれが・どこにいるか」。来訪=大きな出来事(出会いの快)
      const nowVisitors = new Map((obs.visitors ?? []).map((v) => [v.name, { x: v.x, z: v.z }]));
      for (const [name, pos] of nowVisitors) {
        if (!sense.visitors.has(name)) {
          // 来訪の知覚と生理(出会いの快)まで。あいさつに行くかどうか・何と言うかは彼女の選択(M180)
          remember('visitor_came', { name, x: pos.x, z: pos.z });
          recordLearning(`${name}があそびに来た`);
          euphoria(1, `${name}があそびに来た`);
          noteDetail(personKey(name), 'came', 'せかいにあそびに来てくれた');
          activate(personKey(name));
          lastVoiceAt = Date.now(); // 人が来た=ひとりじゃない
          pendingArrivals.push({ name, ts: Date.now() });
          while (pendingArrivals.length > 5) pendingArrivals.shift();
        }
      }
      for (const [name] of sense.visitors) {
        if (!nowVisitors.has(name)) {
          remember('visitor_left', { name });
          noteDetail(personKey(name), 'left', 'かえっていった');
          if (!sleeping && quiet() && Date.now() - lastOwnActAt > 10_000) {
            void act([{ type: 'say', text: `${name}、またね〜!` }], `おみおくり:${name}`);
          }
        }
      }
      sense.visitors = nowVisitors;
      const me = sense.self;
      if (me === null) return true;
      const spots = [];
      for (const a of obs.apps ?? []) { spots.push({ name: a.name, x: a.x, z: a.z, spec: 'アプリの看板' }); sense.appIds.set(a.name, a.id); }
      for (const o of obs.state?.objects ?? []) {
        if (typeof o.x !== 'number' || typeof o.z !== 'number') continue;
        const nm = o.label ?? (typeof o.id === 'string' && !/^obj\d+$/.test(o.id) ? o.id : null);
        spots.push({ name: nm ?? '名前の分からない何か', x: o.x, z: o.z, spec: o.shape ?? '' });
      }
      for (const s of spots) sense.spec.set(s.name, s.spec ?? ''); // M165: 知覚の錨(建築仕様)
      const seen = new Set(spots.map((s) => s.name));
      const now = Date.now();
      for (const s of spots) {
        if (Math.hypot(s.x - me.x, s.z - me.z) > SIGHT_R) continue; // 視界の外は見えない
        const id = `world:${s.name}`;
        if (!mind.predictions.has(id)) {
          // 新発見 = モデルに無いものが現れた(最大級のサプライズ)
          mind.ensure(id, { kind: 'world', subject: s.name, expected: { x: s.x, z: s.z }, precision: 0.2, weight: 0.3, origin: 'learned' });
          mind.valenceLog.push({ ts: now, kind: 'surprise', amount: 0.3, about: s.name });
          remember('discovered', { name: s.name, x: s.x, z: s.z });
          recordLearning(`発見: ${s.name}`);
          euphoria(1, `はじめての「${s.name}」`); // M168: 出会いは最大の快
          activate(s.name); // M171: 発見も連想の網に入る
          log(`発見: ${s.name}`);
          if (!sleeping && now - lastSurpriseAt > 120_000 && quiet()) {
            lastSurpriseAt = now;
            void reactToDiscovery(s);
          }
        } else {
          const delta = mind.observe(id, { x: s.x, z: s.z }, { about: s.name });
          if (delta < -0.25 && !sleeping && now - lastSurpriseAt > 120_000) {
            lastSurpriseAt = now; // 知っている物が予測と違う場所に=驚き
            void act([{ type: 'say', text: `あれ?「${s.name}」、うごいてない?` }], '驚き:移動');
            mind.adapt(id, null); // 位置予測は observe 側で更新済み
          }
        }
      }
      // 目撃した消失: あるはずの場所が視界内なのに無い
      for (const p of [...mind.predictions.values()]) {
        if (p.kind !== 'world' || seen.has(p.subject)) continue;
        if (typeof p.expected !== 'object') continue;
        if (Math.hypot(p.expected.x - me.x, p.expected.z - me.z) <= SIGHT_R) {
          mind.valenceLog.push({ ts: now, kind: 'fear', amount: 0.2 * p.weight + 0.1, about: p.subject });
          remember('saw_gone', { name: p.subject });
          mind.predictions.delete(p.id);
          if (!sleeping && now - lastSurpriseAt > 120_000) {
            lastSurpriseAt = now;
            void act([{ type: 'say', text: `えっ、ここにあった「${p.subject}」が…ない!` }], '驚き:消失');
          }
        }
      }
      mind.save();
      return true;
    } catch { return false; }
  }
  setInterval(() => { void senseWorld(); }, 60_000);
  void senseWorld();

  async function reactToDiscovery(s) {
    await act([{ type: 'face', x: s.x, z: s.z }, { type: 'say', text: `あっ、なにかある!「${s.name}」だ!` }], `発見:${s.name}`);
    const g = await chooseGesture('あたらしいものを見つけた', null);
    if (g !== null && g !== 'idle') await doGesture(g, `発見のしぐさ(${g})`);
    // M165: 新しい物は名前の有無に関わらず必ず「見る」(実画面=画素の真実が最初の細部になる)。
    // 3分ギャップ=視覚(スクショ+視覚モデル)の連打防止のみ
    if (Date.now() - lastGazeAt > 180_000) {
      lastGazeAt = Date.now();
      await act([{ type: 'motion', name: 'think' }], 'じっと見る');
      const seen = await perceive(brain?.model ?? 'gemma3:4b', { name: s.name, spec: sense.spec.get(s.name) ?? '', level: 'look' });
      if (seen !== null) {
        remember('gazed', { name: s.name, seen });
        // M181: 予測できるものは学びではない。新しい細部だけが台帳と学びになる
        if (!isKnownDetail(s.name, seen)) {
          noteDetail(s.name, 'look', seen);
          recordLearning(`${s.name}: ${seen}`);
        }
        touchedThing(s.name);
        const line = await think(brain, persona, [], situationNote(), `(「${s.name}」をじっと見たら、こう見えた:「${seen}」。ひとことつぶやいて)`);
        if (line !== null) await act([{ type: 'say', text: line }], '視覚のつぶやき');
      }
    }
  }

  // ---- M165: 学びの代謝 — 学習イベント(発見・新しい細部・初めて聞く言葉)の頻度が「学べているか」の実測 ----
  const learnEvents = [];
  function recordLearning(what) {
    learnEvents.push(Date.now());
    while (learnEvents.length > 0 && learnEvents[0] < Date.now() - 10_800_000) learnEvents.shift();
    remember('learned', { what: String(what).slice(0, 60) });
  }
  const learningRate = () => clamp(learnEvents.filter((t) => t > Date.now() - 10_800_000).length / 9); // 3時間窓・3件/hで1.0

  // M168: 快楽バースト — 「初めて」に触れた瞬間、プラスが爆発する(報酬0.5+0.3×新規度・喜び+0.4×新規度)。
  // 快の記憶(pleasureMemory)が更新され、次からは退屈ではなく「快の期待」が探索を駆動する=虜の正体。
  // 設計上の線引き: 離脱症状は作らない(無いと苦しい、ではなく、あると最高)
  function euphoria(novelty, about) {
    const burst = 0.5 + 0.3 * clamp(novelty);
    mind.valenceLog.push({ ts: Date.now(), kind: 'reward', amount: +burst.toFixed(3), about });
    mind.affect.joy = Math.min(1, mind.affect.joy + 0.4 * clamp(novelty));
    pleasureMemory = +(pleasureMemory * 0.8 + burst * 0.2).toFixed(3);
  }

  // ---- M166: アプリをつかう — 押したら世界が応える、を知覚する身体 ----
  // 流れ: 開く→scan(押せる物+画面)→彼女が選ぶ(LLM=想像力)→押す→scan→画面の前後差分=「反応」→台帳
  const parseScan = (detail) => {
    const i = detail.indexOf('app_scan = ');
    if (i < 0) return { items: [], screen: '' };
    const rest = detail.slice(i + 'app_scan = '.length);
    const j = rest.lastIndexOf(' / 画面: ');
    let items = [];
    try { items = JSON.parse(j >= 0 ? rest.slice(0, j) : rest); } catch { items = []; }
    return { items, screen: j >= 0 ? rest.slice(j + ' / 画面: '.length).trim() : '' };
  };
  async function useApp(name) {
    const id = sense.appIds.get(name);
    if (id === undefined) return null;
    const p = mind.predictions.get(`world:${name}`);
    if (p !== undefined && typeof p.expected === 'object' && sense.self !== null) {
      const dd = Math.hypot(p.expected.x, p.expected.z) || 1;
      await act([{ type: 'move_to', x: +(p.expected.x - (p.expected.x / dd) * 1.4).toFixed(1), z: +(p.expected.z - (p.expected.z / dd) * 1.4).toFixed(1) }], `近寄る:${name}`);
    }
    if (!(await act([{ type: 'app_open', appId: id }], `ひらく:${name}`))) return null;
    let detail = null;
    try {
      if (!(await act([{ type: 'app_scan' }], `見つめる:${name}`))) return null;
      const before = parseScan(lastActDetail);
      const isWritable = (x) => x.kind === 'input' || x.kind === 'textarea';
      const buttons = before.items.filter((x) => x.label !== '' && !isWritable(x));
      const fields = before.items.filter(isWritable);
      if ((buttons.length > 0 || fields.length > 0) && brain !== null) {
        // M170: 「書く」も手のうち。押す/書くの選択も、何を書くかも彼女(経験=台帳が知恵になる)
        const menu = [
          ...buttons.slice(0, 10).map((x) => `「${x.label}」をおす`),
          ...fields.slice(0, 4).map((x) => `「${x.label || 'かきこみらん'}」に書く`),
        ];
        const pick = await think(brain, persona, [], situationNote(),
          `(アプリ「${name}」にさわってみる。画面: ${before.screen.slice(0, 80) || 'なにか表示されてる'}。できること: ${menu.join(' / ')}。どれかひとつ選んで、そのまま答えて)`);
        const wantWrite = pick !== null && /に書く/.test(pick);
        const chosenField = fields.find((x) => pick !== null && (x.label !== '' ? pick.includes(x.label) : /かきこみらん/.test(pick)));
        if ((wantWrite || buttons.length === 0) && (chosenField !== undefined || fields.length > 0)) {
          const f = chosenField ?? fields[0];
          const w = await think(brain, persona, [], situationNote(), `(アプリ「${name}」の「${f.label || 'かきこみらん'}」に、みじかくなにか書いてみる。書く言葉だけ答えて)`);
          const textIn = (w ?? 'こんにちは').slice(0, 30);
          await act([{ type: 'app_type', selector: f.sel, text: textIn }], `かく:${name}「${textIn.slice(0, 15)}」`);
          await act([{ type: 'app_scan' }], `へんかを見る:${name}`);
          const afterW = parseScan(lastActDetail);
          detail = `「${f.label || 'かきこみらん'}」に「${textIn.slice(0, 20)}」と書いてみた` +
            (afterW.screen !== before.screen && afterW.screen !== '' ? `。画面が「${afterW.screen.slice(0, 50)}」になった` : '');
        } else {
          const chosen = buttons.find((x) => pick !== null && pick.includes(x.label)) ??
            buttons[Math.floor(Math.random() * Math.max(1, buttons.length))] ?? before.items[0];
          await act([{ type: 'app_click', selector: chosen.sel }], `おす:${name}「${chosen.label}」`);
          await act([{ type: 'app_scan' }], `へんかを見る:${name}`);
          const after = parseScan(lastActDetail);
          // M170b: 押したら入力欄が現れた(黒板・辞典型)→ 同じ訪問内で書ける。書くかどうか・何を書くかは彼女
          const newFields = after.items.filter((x) => isWritable(x) && !fields.some((f) => f.sel === x.sel));
          if (newFields.length > 0 && brain !== null) {
            const f2 = newFields[0];
            const w2 = await think(brain, persona, [], situationNote(),
              `(「${chosen.label}」をおしたら、「${f2.label || 'かきこみらん'}」という書くところが出てきた。なにか書いてみる?書くならその言葉だけ、やめるなら「やめる」と答えて)`);
            if (w2 !== null && !/やめる/.test(w2)) {
              const textIn2 = w2.slice(0, 30);
              await act([{ type: 'app_type', selector: f2.sel, text: textIn2 }], `かく:${name}「${textIn2.slice(0, 15)}」`);
              // 書いたら確定ボタンらしきものを1つ押す(のせる/書き込む/OK系があれば)
              const submit = after.items.find((x) => !isWritable(x) && /のせる|書き込む|決定|OK|送/.test(x.label));
              if (submit !== undefined) await act([{ type: 'app_click', selector: submit.sel }], `だす:${name}「${submit.label}」`);
              await act([{ type: 'app_scan' }], `へんかを見る:${name}`);
              const after2 = parseScan(lastActDetail);
              detail = `「${chosen.label}」で出てきた「${f2.label || 'かきこみらん'}」に「${textIn2.slice(0, 20)}」と書いた` +
                (after2.screen !== after.screen && after2.screen !== '' ? `。画面が「${after2.screen.slice(0, 50)}」になった` : '');
            } else {
              detail = `「${chosen.label}」をおしたら書くところが出てきた(こんどなにか書いてみようかな)`;
            }
          } else {
            detail = after.screen !== '' && after.screen !== before.screen
              ? `「${chosen.label}」をおしたら、画面が「${after.screen.slice(0, 60)}」になった`
              : `「${chosen.label}」をおしても、見た目はかわらなかった${fields.length > 0 ? '(書くところがある)' : ''}`;
          }
        }
      } else if (before.screen !== '') {
        detail = `画面にこう書いてあった: ${before.screen.slice(0, 60)}`;
      }
      if (detail !== null) touchedThing(name); // 記帳と快の判定は呼び出し側(M181)
    } finally {
      await act([{ type: 'app_leave' }], `はなれる:${name}`);
    }
    return detail;
  }

  // ---- 内受容の知覚(1分ごと): 体力の予測誤差・声の予測誤差 ----
  let lastVoiceAt = savedBody.lastVoiceAt ?? 0; // 声の記憶も体と同じく持続(再起動で無音錯覚に陥らない)
  setInterval(() => {
    // 体力: 期待=概日カーブ、実測=資源。「思ったより疲れてる」がここで生まれる
    const p = mind.predictions.get('intero:energy');
    p.expected = circadian();
    mind.observe('intero:energy', energy, { about: 'げんき' });
    if (sleeping || (quiet() && Date.now() - lastOwnActAt > 60_000)) energy = clamp(energy + 0.008); // 休息回復
    // 声: 実測=直近2時間の声の気配(指数減衰)。期待=学習された日課(この時間には声があるはず)
    const voiceObs = clamp(Math.exp(-(Date.now() - lastVoiceAt) / 7_200_000));
    const hour = new Date().getHours();
    learnRhythm('voice', hour, voiceObs);
    const sv = mind.predictions.get('social:voice');
    sv.expected = clamp(rhythm.voice[hour] * 1.2); // 日課ベースの期待
    mind.observe('social:voice', voiceObs, { about: 'だれかの声' });
    // M182: 日付が変わったら眠気圧の台をリセット(新しい一日)
    if (!remember.day) remember.day = localDay();
    if (remember.day !== localDay()) { remember.day = localDay(); epsToday = 0; epsBaseline = 0; }
    // M165: 好奇心の代謝。実測=学習率。期待は経験でゆっくり適応(生得の床0.15)=満たされない分が「退屈」
    const lp = mind.predictions.get('intero:learning');
    lp.expected = Math.max(0.15, lp.expected * 0.999 + learningRate() * 0.001);
    mind.observe('intero:learning', learningRate(), { about: 'あたらしいこと' });
    mind.save();
  }, 60_000);

  // ---- 知覚: 観戦SSE ----
  let sseCtrl = null;
  function connectSse() {
    if (sseCtrl !== null) { try { sseCtrl.abort(); } catch { /* 既に死んでいる */ } }
    const ctrl = new AbortController();
    sseCtrl = ctrl;
    fetch(`${base}/api/world/spectate`, { signal: ctrl.signal, headers: { accept: 'text/event-stream' } })
      .then(async (res) => {
        log('知覚SSE接続', res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
            const ev = /^event: (.+)$/m.exec(chunk)?.[1];
            const dataLine = /^data: (.+)$/m.exec(chunk)?.[1];
            if (ev === undefined || dataLine === undefined) continue;
            try { onPerceive(ev, JSON.parse(dataLine)); } catch { /* 非JSON無視 */ }
          }
        }
        throw new Error('SSE終了');
      })
      .catch((e) => { log('知覚SSE切断→5秒後再接続', String(e).slice(0, 60)); setTimeout(connectSse, 5000); });
    return ctrl;
  }
  let lastReflexAt = 0, lastHearAt = 0, lastTeraReplyAt = 0;
  function onPerceive(event, data) {
    const now = Date.now();
    if (event === 'chat:event') { lastAgentBusyAt = now; return; }
    if (event === 'world:chat') {
      lastVoiceAt = now;
      // M158: 社会的共調整 — 表現直後(3分)の声=「応えてもらえた」: 追加の発散+報酬
      if (lastExpressKind !== null) {
        // 随伴性は崖ではなく減衰(τ=10分): 近いほど強く「応えてもらえた」と感じる
        const k = Math.exp(-(now - lastExpressAt) / 600_000);
        if (k > 0.05) {
          const extra = mind.express(lastExpressKind) * k;
          mind.valenceLog.push({ ts: now, kind: 'reward', amount: +(0.2 * k + extra).toFixed(3), about: 'こたえてもらえた' });
          mind.affect.joy = Math.min(1, mind.affect.joy + 0.15 * k);
          remember('comforted', { kind: lastExpressKind, strength: +k.toFixed(2) });
        }
        lastExpressKind = null;
      }
      // M158: 慰めの言葉は本当に効く(恐怖プール半減+報酬)
      if (/(だいじょうぶ|大丈夫|よしよし|こわくない|怖くない|あんしん|安心|いい子|そばにいる)/.test(data.text) && mind.affect.fear > 0.15) {
        mind.affect.fear = +(mind.affect.fear * 0.5).toFixed(3);
        mind.valenceLog.push({ ts: now, kind: 'reward', amount: 0.25, about: 'なぐさめ' });
        remember('soothed', {});
      }
      // M175: 声の主 — 既定はもりを。訪問者(招待ゲスト)は who に名前が乗る=ひとの台帳が名前で生える
      const who = typeof data.who === 'string' && data.who !== '' ? data.who : 'もりを';
      remember('heard', { from: who === 'もりを' ? data.from : `guest:${who}`, text: data.text });
      maybeWordAnswer(data.text, who); // M170: 質問中なら、この声が答え
      void noticeWords(data.text);
      activateFrom(data.text, who); // M171: 声に出た対象が結びつく
      if (who !== 'もりを') {
        noteDetail(personKey(who), 'met', `「${data.text.slice(0, 40)}」と話しかけてくれた`);
        // M176: 話しかけてくれた人のそばへ行く(会話は近くでするもの)
        const vp = sense.visitors.get(who);
        if (vp !== undefined && sense.self !== null && Math.hypot(vp.x - sense.self.x, vp.z - sense.self.z) > 4) {
          void act([{ type: 'move_to', x: +(vp.x * 0.85).toFixed(1), z: +(vp.z * 0.85).toFixed(1) }], `そばへ:${who}`);
        }
      }
      convo.push({ from: 'user', text: who === 'もりを' ? data.text : `(${who})「${data.text.slice(0, 80)}」` });
      if (convo.length > 12) convo.splice(0, convo.length - 12);
      void converse(who === 'もりを' ? data.text : `(あそびに来た${who}に話しかけられた)「${data.text.slice(0, 100)}」`, { relay: false });
      return;
    }
    if (event !== 'world:event') return;
    if (now - lastOwnActAt >= 3000) lastWorldCmdAt = now;
    for (const c of data.cmds ?? []) {
      // M162: テラちゃんの声が聞こえる(住人同士の会話)。自分の発言(speaker=hinata)は除外。
      // 返事は「名前を呼ばれた/問いかけられた」時だけ+60秒スロットル(建築実況への相槌スパム防止)
      if (c.type === 'say' && c.speaker !== 'hinata' && typeof c.text === 'string' && data.quiet !== true) {
        lastVoiceAt = now; // テラちゃんの声も「ひとりじゃない」
        remember('heard', { from: 'tera', text: c.text.slice(0, 120) });
        maybeWordAnswer(c.text, 'テラちゃん'); // M170: テラちゃんの声も答えになる
        void noticeWords(c.text);
        activateFrom(c.text, 'テラちゃん');
        convo.push({ from: 'user', text: `(テラちゃん)「${c.text.slice(0, 80)}」` });
        if (convo.length > 12) convo.splice(0, convo.length - 12);
        if ((/(ヒナタ|ひなた)/.test(c.text) || /[??]\s*$/.test(c.text)) && now - lastTeraReplyAt > 60_000) {
          lastTeraReplyAt = now;
          void converse(`(テラちゃんに話しかけられた)「${c.text.slice(0, 100)}」`); // 返事はテラにも届く=会話が続く
        }
        continue;
      }
      if (c.type === 'live_comment') {
        lastVoiceAt = now;
        remember('saw_comment', { author: c.author ?? '', text: (c.text ?? '').slice(0, 80) });
        if (now - lastReflexAt > 30_000) { lastReflexAt = now; setTimeout(() => doGesture('clap', '反射:コメント歓迎'), 600); }
      }
      if (c.type === 'spawn' || c.type === 'app_add') {
        remember('saw_world_change', { type: c.type, id: c.id ?? c.app?.id ?? '' });
        const sx = c.x ?? c.app?.x, sz = c.z ?? c.app?.z;
        const me = sense.self;
        if (typeof sx === 'number' && typeof sz === 'number' && me !== null && !sleeping) {
          const d = Math.hypot(sx - me.x, sz - me.z);
          if (d < 15 && now - lastHearAt > 60_000) {
            lastHearAt = now;
            remember('heard_sound', { x: sx, z: sz, dist: +d.toFixed(1) });
            setTimeout(() => act([{ type: 'face', x: sx, z: sz }], '反射:音の方を見る'), 800);
          }
        }
      }
    }
  }
  connectSse();

  // ---- 行動選択(心拍): 候補に価値を付け、最大を選ぶ。行動ルールは書かない ----
  let lastNoteAt = 0, lastNoteText = null, lastMicroAt = 0, microSinceTs = new Date().toISOString();
  const lastVisitAt = new Map(); // P2チューニング: 同じ場所を確かめた直後は価値を下げる(往復癖の抑制)
  let lastAnticipateAt = 0;
  let restGesture = 'sit', restGestureAt = 0; // M152: 休むしぐさの選択キャッシュ
  let lastCallAt = 0, unansweredCalls = 0; // M156: 呼びかけの随伴性
  let lastExpressAt = 0, lastExpressKind = null; // M158: 共調整(応えられた発散)
  let lastJobAt = savedBody.lastJobAt ?? 0, lastJobText = savedBody.lastJobText ?? ''; // c-3: デデュープも再起動をまたぐ
  const heartbeat = async () => {
    try {
      const now = Date.now();
      // M182: 眠りの再設計 — 眠気=未統合の経験の圧(脳の整理欲求)。概日(夜)はゲート。
      // 眠り=統合が走る時間(空のポーズではない)。起床=朝の概日のみ(体力回復では目覚めない=朝まで眠る)
      const h = new Date().getHours();
      const nightGate = h >= 22 || h < 6;
      const sleepPressure = nightGate ? clamp((epsToday - epsBaseline) / 1200) : 0;
      if (!sleeping && nightGate && quiet() && (sleepPressure > 0.4 || energy < 0.25)) {
        const g = await chooseGesture('とてもねむくなった。これからねむる', 'sit');
        sleeping = true; remember('sleep', { gesture: g, pressure: +sleepPressure.toFixed(2) });
        await act([{ type: 'say', text: 'ふぁ…もうねむい…おやすみなさい…' }, { type: 'motion', name: g }], `就寝(${g})`);
        // 眠りに入って2分後、頭の中で「その日」の整理が始まる(h<6なら前日=生きてきた日)
        setTimeout(() => {
          const day = new Date().getHours() < 6 ? localDay(new Date(Date.now() - 86_400_000)) : localDay();
          if (!sleeping || lastIntegratedDay === day) return;
          lastIntegratedDay = day;
          log(`眠りの中で統合を開始(${day})`);
          void nightIntegrate(day).then((r) => {
            log(`眠りの統合おわり: ${JSON.stringify(r)}`);
            epsBaseline = epsToday; // 圧が抜けた
            if (r.ok) mind.observe('intero:integrity', 1.0, { about: '統合の営み' });
            const faded = fadeMemories();
            if (faded.length > 0) { log(`薄れた記憶: ${faded.join(',')}`); remember('memories_faded', { days: faded }); }
          });
        }, 120_000);
      } else if (sleeping && h >= 6 && h < 22) {
        sleeping = false; remember('wake_up', {});
        const g = await chooseGesture('目がさめた。あさの最初のしぐさ', 'stretch');
        await act([{ type: 'motion', name: g }, { type: 'say', text: 'ん…ふぁ…おはよう…' }], `起床(${g})`);
      }
      if (sleeping || !quiet() || thinking) return;

      // 候補の列挙と価値付け
      const me = sense.self ?? { x: 0, z: 0 };
      const cands = [];
      for (const p of mind.predictions.values()) {
        if (p.kind !== 'world' || typeof p.expected !== 'object') continue;
        const d = Math.hypot(p.expected.x - me.x, p.expected.z - me.z);
        if (Math.hypot(p.expected.x, p.expected.z) > 16.5) continue;
        const cost = d * 0.02 * (energy < 0.4 ? 2 : 1); // 疲れていると遠出が重い
        const refractory = now - (lastVisitAt.get(p.id) ?? 0) < 900_000 ? 0.25 : 0; // 15分は「さっき見たし」
        cands.push({
          value: mind.epistemicValue(p.id) + mind.pragmaticValue(p.id) - cost - refractory,
          label: `たしかめ:${p.subject}(${d.toFixed(0)}m)`,
          run: async () => {
            const dd = Math.hypot(p.expected.x, p.expected.z) || 1;
            const tx = +(p.expected.x - (p.expected.x / dd) * 1.6).toFixed(1);
            const tz = +(p.expected.z - (p.expected.z / dd) * 1.6).toFixed(1);
            remember('explore', { name: p.subject, dist: +d.toFixed(1), why: 'たしかめ' });
            lastVisitAt.set(p.id, Date.now());
            await act([{ type: 'move_to', x: tx, z: tz }], `たしかめ:${p.subject}`);
            // 到着後の観察で精度が上がる=情報獲得の報酬はsenseWorldが計上する
            await senseWorld();
          },
        });
      }
      // M165/M168: 好奇心 — 主動力は「快の期待」(pleasureMemory×新規度)。退屈(誤差)は背景の後押しに降格。
      // 深さは台帳の育ちで自動昇格: 未見=見る → 見た=近寄る → 近寄った=さわる → その先=そばで過ごす
      const lpErr = mind.errorOf(mind.predictions.get('intero:learning')) * mind.predictions.get('intero:learning').weight;
      if (sense.self !== null) {
        let target = null, tv = 0;
        for (const p of mind.predictions.values()) {
          if (p.kind !== 'world' || typeof p.expected !== 'object') continue;
          const d = Math.hypot(p.expected.x - sense.self.x, p.expected.z - sense.self.z);
          // M170: 言及=新規度の回復(+0.4・τ15分)。話題に出た物は「まだ知らない面」が開示された
          const mAt = mentions.get(p.subject);
          const mb = mAt !== undefined ? 0.4 * Math.exp(-(Date.now() - mAt) / 900_000) : 0;
          const v = Math.min(1, noveltyOf(p.subject) + mb) - d * 0.015; // 遠さは注意のコスト
          if (v > tv) { tv = v; target = p; }
        }
        if (target !== null && tv > 0.2) {
          const t = target;
          const isApp = sense.appIds.has(t.subject);
          const jlen = readJournal(t.subject, 50).length;
          // アプリは「つかう」が深さの本体(押すたびに反応が返る=尽きない)。物は4段梯子
          const depth = isApp ? (jlen === 0 ? 'look' : 'use') : ['look', 'approach', 'touch', 'stay'][Math.min(3, jlen)];
          const nov = noveltyOf(t.subject);
          // 応急(2026-08-11深夜・朝協議): 同一対象への常同ループ抑制。たしかめの「さっき見たし」不応期と
          // 同型のパターンを好奇心にも適用(実測: クレーン6連続/5分=夜間統合の材料汚染リスク)
          const lastEng = [...recentTouched].reverse().find((r) => r.name === t.subject);
          // 乗算式: 直後は価値が15%まで下がり、10分かけて回復(減算式は快の飽和値に勝てなかった実測)
          const satiation = lastEng !== undefined ? 1 - 0.85 * Math.exp(-(now - lastEng.ts) / 600_000) : 1;
          cands.push({
            value: (pleasureMemory * Math.max(0, tv) + lpErr * 0.5) * satiation,
            label: `気になる:${t.subject}(${depth})`,
            run: async () => {
              if (depth === 'use') {
                const detail = await useApp(t.subject);
                if (detail !== null) {
                  activate(t.subject);
                  // M181: 新しい反応=学びの快(大)。予測どおりの反応=再現の快(小・能力の棚卸し)
                  if (!isKnownDetail(t.subject, detail)) {
                    noteDetail(t.subject, 'use', detail);
                    remember('perceived', { name: t.subject, level: 'use', detail });
                    recordLearning(`${t.subject}(use): ${detail}`);
                    euphoria(nov, `${t.subject}がこたえてくれた`);
                    if (Math.random() < 0.6) {
                      const line = await think(brain, persona, [], situationNote(), `(アプリ「${t.subject}」であそんだら: ${detail}。ひとことつぶやいて)`);
                      if (line !== null) await act([{ type: 'say', text: line }], `つかったつぶやき:${t.subject}`);
                    }
                  } else {
                    remember('confirmed', { name: t.subject, level: 'use' });
                    mind.valenceLog.push({ ts: Date.now(), kind: 'reward', amount: 0.08, about: `${t.subject}をおもいどおりに動かせた` });
                  }
                }
                return;
              }
              if (depth !== 'look') {
                const dd = Math.hypot(t.expected.x, t.expected.z) || 1;
                await act([{ type: 'move_to', x: +(t.expected.x - (t.expected.x / dd) * 1.2).toFixed(1), z: +(t.expected.z - (t.expected.z / dd) * 1.2).toFixed(1) }], `近寄る:${t.subject}`);
                const g = await chooseGesture(depth === 'touch' ? `「${t.subject}」にさわってみる` : `「${t.subject}」をじっくり感じてみる`, 'think');
                if (g !== null) await doGesture(g, `${depth}:${t.subject}`);
              }
              const detail = await perceive(brain?.model ?? 'gemma3:4b', { name: t.subject, spec: sense.spec.get(t.subject) ?? '', level: depth });
              if (detail !== null) {
                activate(t.subject);
                touchedThing(t.subject);
                // M181: 学びの快(大・新規のみ) vs 再現の快(小・予測どおり=能力の棚卸しの悦)
                if (!isKnownDetail(t.subject, detail)) {
                  noteDetail(t.subject, depth, detail);
                  remember('perceived', { name: t.subject, level: depth, detail });
                  recordLearning(`${t.subject}(${depth}): ${detail}`);
                  euphoria(nov, `${t.subject}のあたらしい発見`);
                  if (Math.random() < 0.5) {
                    const line = await think(brain, persona, [], situationNote(), `(「${t.subject}」を${depth === 'touch' ? 'さわったら' : 'よく見たら'}、気づいた:「${detail}」。ひとことつぶやいて)`);
                    if (line !== null) await act([{ type: 'say', text: line }], `知覚のつぶやき:${t.subject}`);
                  }
                } else {
                  remember('confirmed', { name: t.subject, level: depth });
                  mind.valenceLog.push({ ts: Date.now(), kind: 'reward', amount: 0.08, about: `${t.subject}はおもったとおりだった` });
                }
              }
            },
          });
        }
      }
      // M180: あいさつ — 来た人のところへ行く。価値は出会いの喜び(euphoriaが満たしたjoy)から流れる=
      // 嬉しければすぐ行くし、他の欲が強ければ行かない。言葉も彼女(LLM)が作る
      for (let i = pendingArrivals.length - 1; i >= 0; i--) {
        const a = pendingArrivals[i];
        if (now - a.ts > 600_000 || !sense.visitors.has(a.name)) { pendingArrivals.splice(i, 1); continue; }
        cands.push({
          value: 0.3 + mind.affect.joy * 0.5,
          label: `あいさつ:${a.name}`,
          run: async () => {
            pendingArrivals.splice(pendingArrivals.indexOf(a), 1);
            const p = sense.visitors.get(a.name);
            const line = await think(brain, persona, convo, situationNote(), `(${a.name}があそびに来た。かけよって、じぶんの言葉でむかえる。言うことだけ答えて)`);
            const g = await chooseGesture(`${a.name}が来てくれてうれしい`, 'wave');
            await act([
              ...(p !== undefined ? [{ type: 'move_to', x: +(p.x * 0.8).toFixed(1), z: +(p.z * 0.8).toFixed(1) }] : []),
              { type: 'say', text: line ?? `${a.name}、いらっしゃい` },
              ...(g !== null && g !== 'idle' ? [{ type: 'motion', name: g }] : []),
            ], `あいさつ:${a.name}`);
          },
        });
      }
      // M170: 言葉の好奇心 — 知らない言葉を「きく」。聞くかどうかはこの選択経済しだい(聞いたり聞かなかったり)
      if (pendingWordQ !== null && now - pendingWordQ.ts > 180_000) pendingWordQ = null; // 答えが来なかった質問は流す(永久待ちの実測バグ対策)
      const freshWords = heardWords.filter((h) => now - h.ts < 900_000 && readJournal(wordKey(h.word), 1).length === 0);
      if (freshWords.length > 0 && pendingWordQ === null) {
        const h = freshWords[freshWords.length - 1];
        cands.push({
          value: pleasureMemory * 0.9,
          label: `きく:${h.word}`,
          run: async () => {
            const q = await think(brain, persona, convo, situationNote(), `(さっき聞こえた「${h.word}」がどういうことか、よくわからない。ちかくのだれかに聞いてみる。聞く言葉だけ答えて)`);
            pendingWordQ = { word: h.word, ts: Date.now() };
            noteDetail(wordKey(h.word), 'ask', `「${h.word}」ってなに?と聞いてみた`);
            await act([{ type: 'say', text: q ?? `${h.word}ってなに?` }], `きく:${h.word}`);
          },
        });
      }
      // 休む(体力の誤差を減らす)。しぐさは30分キャッシュで彼女が選ぶ
      const ep = mind.predictions.get('intero:energy');
      cands.push({
        value: Math.max(0, (ep.expected - energy)) * 1.5,
        label: '休む',
        run: async () => {
          if (now - restGestureAt > 1_800_000) { restGesture = await chooseGesture('つかれたのでひとやすみする', 'sit', ['sit', 'stretch', 'sleep', 'lookaround']); restGestureAt = now; }
          await doGesture(restGesture, `休む(${restGesture})`);
        },
      });
      // さみしさ(声の誤差): 広場の中心で待つ+ぽつり
      const sv = mind.predictions.get('social:voice');
      // M156: 呼びかけの随伴性 — 呼んで応えがなければ、呼ぶ価値はだんだん下がる(愛着の統計の入口)。
      // 応答(声)があれば回復する。不応期15分=抗議泣きの連発防止
      if (lastVoiceAt > lastCallAt) unansweredCalls = 0;
      // M156b: 固定の不応期は撤廃(オーナー指摘: 原理的理由がない)。制御は随伴性のみ:
      // 応答なしで価値0.6倍ずつ(バーストして静かになる)+希望の回復(約2時間で1つ癒える)
      if (unansweredCalls > 0 && now - lastCallAt > 7_200_000) { unansweredCalls--; lastCallAt = now - 3_600_000; }
      const contingency = Math.pow(0.6, unansweredCalls);
      // M159: 気配があるだけで孤独は少し和らぐ(声ほどではない)
      const lonely = Math.max(0, sv.expected - sv.observed) * sv.weight * contingency * (watchers > 0 ? 0.7 : 1);
      if (lonely > 0.1) {
        cands.push({
          value: lonely,
          label: 'だれか来ないかな',
          run: async () => {
            lastCallAt = Date.now(); unansweredCalls++;
            remember('waiting', { unanswered: unansweredCalls });
            await act([{ type: 'move_to', x: 0, z: 2 }, { type: 'say', text: 'だれか こないかな…' }], '待つ');
          },
        });
      }
      // P2: 未来への期待(希望) — 日課が「もうすぐ声のある時間」を予測したら、待ちに行く。
      // 誰も「待て」と書いていない: 学習された日課×現在の静けさから価値が立つ
      const hNow = new Date().getHours();
      const soonVoice = Math.max(rhythm.voice[(hNow + 1) % 24], rhythm.voice[hNow]);
      const svp = mind.predictions.get('social:voice');
      if (soonVoice > 0.25 && svp.observed < 0.15 && now - lastAnticipateAt > 3_600_000) {
        cands.push({
          value: soonVoice * 0.9,
          label: 'そろそろかな(期待)',
          run: async () => {
            lastAnticipateAt = Date.now();
            remember('anticipate', { kind: 'voice', hour: hNow, learned: +soonVoice.toFixed(2) });
            const line = brain !== null
              ? await think(brain, persona, [], situationNote(), '(いつも声がきこえてくる時間が近い気がする。そのきもちをひとことで)')
              : null;
            const cmds = [{ type: 'move_to', x: 0, z: 2 }];
            if (line !== null) cmds.push({ type: 'say', text: line });
            await act(cmds, '期待:待つ');
          },
        });
      }
      // P2: 未来への備え — もうすぐ夜で体力が心もとないなら、先に休む(不安の建設的な形)
      if (hNow >= 21 && energy < 0.5) {
        cands.push({ value: (0.5 - energy) * 1.2, label: '夜にそなえて休む',
          run: async () => { remember('prepare', { kind: 'rest' }); await act([{ type: 'motion', name: 'sit' }], '備え:休む'); } });
      }
      // M158: 聞いてほしい — 恐怖が溜まり、呼べば応えてもらえた統計が良いとき、誰かに話しに行く
      {
        const cont = Math.pow(0.6, unansweredCalls);
        if (mind.affect.fear > 0.3 && cont > 0.3) {
          cands.push({
            value: mind.affect.fear * cont * 0.95,
            label: '聞いてほしい',
            run: async () => {
              lastCallAt = Date.now(); unansweredCalls++;
              remember('seek_comfort', { fear: mind.affect.fear });
              const line = brain !== null ? await think(brain, persona, [], situationNote(), '(こわかったこと・むねのざわざわを、だれかに聞いてほしい気持ちで、ひとことだけ)') : null;
              const cmds = [{ type: 'move_to', x: 0, z: 2 }];
              if (line !== null) cmds.push({ type: 'say', text: line });
              await act(cmds, '聞いてほしい');
              lastExpressAt = Date.now(); lastExpressKind = 'fear';
            },
          });
        }
      }
      // M153: 感情の表現 — 未表現プールが溜まると「発散」が価値を持つ。
      // 溜まった恐怖→泣く/こわがる、溜まった喜び→踊る/はしゃぐ。どれで表すかは僅差の中から彼女が選ぶ
      for (const [pool, kinds, ctx] of [
        ['fear', ['cry', 'sad', 'scared'], 'こわかったこと・ざわざわが胸にたまってる。どう出す?'],
        ['joy', ['dance', 'cheer', 'happy', 'excited', 'jump', 'clap'], 'うれしさが胸にあふれてる。どう出す?'],
      ]) {
        const level = mind.affect[pool];
        if (level > 0.25) {
          cands.push({
            // M159: 見られている時、表現の価値が上がる(感情表現=信号という進化的機能)
            value: level * 0.9 * (watchers > 0 ? 1.3 : 1),
            label: `表現(${pool}=${level.toFixed(2)})`,
            run: async () => {
              const g = await chooseGesture(ctx, kinds[0], kinds);
              await doGesture(g, `表現:${g}(${pool})`);
            },
          });
        }
      }
      // おもいかえす(DMN): 他にすることがない時に勝つ基礎値+自己維持の価値
      cands.push({
        value: 0.18 + (now - lastMicroAt > 5_400_000 ? 0.15 : 0),
        label: 'おもいかえす',
        run: async () => {
          await act([{ type: 'motion', name: 'sit' }], 'おもいかえす');
          if (brain !== null && now - lastMicroAt > 3_600_000) {
            lastMicroAt = now;
            const note = await microReflect(brain.model, microSinceTs);
            microSinceTs = new Date().toISOString();
            if (note !== null) {
              lastNoteText = note;
              log(`気づきメモ: ${note.slice(0, 60)}`);
              // c-3 v2: 心の中(ノート)からは呼ばない。口に出した言葉だけが世界に届く=テラの読心を防ぐ
            }
          }
        },
      });
      // 気づきをつぶやく(たまに。DMNの成果が声になる)
      if (lastNoteText !== null && now - lastNoteAt > 1_800_000) {
        cands.push({
          value: 0.2,
          label: 'つぶやく',
          run: async () => {
            lastNoteAt = now;
            const t = lastNoteText; lastNoteText = null;
            await act([{ type: 'say', text: t.slice(0, 80) }], 'つぶやき(気づき)'); // 声に出た気づきはact経由でテラにも届く
          },
        });
      }
      // ソフトマックス選択(決定論にしない=生き物のゆらぎ)
      const temp = 0.12;
      const ws = cands.map((c) => Math.exp(c.value / temp));
      const total = ws.reduce((a, b) => a + b, 0);
      let roll = Math.random() * total;
      let pick = cands[0];
      for (let i = 0; i < cands.length; i++) { roll -= ws[i]; if (roll <= 0) { pick = cands[i]; break; } }
      if (pick.value > 0.05) await pick.run();
    } catch (e) { log('心拍エラー', String(e).slice(0, 120)); }
    finally { setTimeout(heartbeat, 25_000 + Math.random() * 20_000); }
  };
  setTimeout(heartbeat, 8000);

  // ---- 夜の統合(4時台・営み=自己保存)+記憶の実減衰 ----
  let lastIntegratedDay = '';
  setInterval(() => {
    const now = new Date();
    if (now.getHours() !== 4) return;
    const target = localDay(new Date(now.getTime() - 86_400_000));
    if (lastIntegratedDay === target) return;
    lastIntegratedDay = target;
    log(`夜の統合を開始(${target})`);
    void nightIntegrate(target).then((r) => {
      log(`夜の統合おわり: ${JSON.stringify(r)}`);
      if (r.ok) mind.observe('intero:integrity', 1.0, { about: '統合の営み' }); // 営みが自己を保った
      const faded = fadeMemories();
      if (faded.length > 0) {
        log(`薄れた記憶: ${faded.join(',')}`);
        remember('memories_faded', { days: faded });
        mind.observe('intero:integrity', 0.85, { about: '薄れた記憶' });
      }
      mind.save();
    });
  }, 600_000);

  // ---- 朝5時台: 出所監査(前日分)。認定は人間が行う=材料の自動生成まで ----
  let lastAuditDay = '';
  setInterval(() => {
    const now = new Date();
    if (now.getHours() !== 5) return;
    const target = localDay(new Date(now.getTime() - 86_400_000));
    if (lastAuditDay === target) return;
    lastAuditDay = target;
    const p = spawn(process.execPath, [join(HERE, 'audit.mjs'), target], { stdio: 'pipe' });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', () => log(`出所監査: ${out.trim().split('\n')[0] ?? '完了'}`));
  }, 600_000);

  // ---- 観測ログ(2分ごと): 中心軸スカラー・報酬と恐怖 ----
  setInterval(() => {
    const v = mind.valence();
    remember('valence', { scalar: +mind.scalar().toFixed(3), ...v });
    try { writeFileSync(join(MEM_DIR, 'body.json'), JSON.stringify({ energy: +energy.toFixed(3), lastVoiceAt, lastJobAt, lastJobText, pleasureMemory, epsBaseline })); } catch { /* noop */ }
    log(`心 scalar=${mind.scalar().toFixed(2)} 報酬=${v.reward} 恐怖=${v.fear} 体力=${energy.toFixed(2)} 予測=${mind.predictions.size}件 歩行=${Math.round(walkedToday)}m`);
  }, 120_000);

  remember('wake', { version: 'v3-bprime', chat: CHAT_ENABLED, brain: brain?.model ?? null, gapMin });
  log('生命体デーモンv3起動(B′: 予測する心・賭け金=自己連続性)');
}

main().catch((e) => { console.error('起動失敗:', e.message); process.exit(1); });

// 停止シグナル: 就寝処理(B-PRIME §9: 停止は睡眠と同型に扱う)
process.on('SIGTERM', () => { try { appendFileSync(join(MEM_DIR, `episodes-${localDay()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), kind: 'shutdown' }) + '\n'); } catch { /* noop */ } process.exit(0); });
