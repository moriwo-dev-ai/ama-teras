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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectBrain, think } from './brain.mjs';
import { lookAtWorld } from './eyes.mjs';
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
function remember(kind, data) {
  try {
    appendFileSync(join(MEM_DIR, `episodes-${localDay()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + '\n');
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
mind.ensure('intero:integrity', { kind: 'intero', subject: 'わたしのつづき', expected: 1.0, precision: 0.8, weight: 1.0, origin: 'innate' });
mind.ensure('intero:energy', { kind: 'intero', subject: 'げんき', expected: 0.8, precision: 0.5, weight: 0.6, origin: 'innate' });
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

// ---------- 体(資源としてのエネルギー)と概日 ----------
let energy = 0.8;           // 物理資源: 歩けば減り、休めば戻る
let sleeping = false;
let walkedToday = 0;
const circadian = () => { const h = new Date().getHours() + new Date().getMinutes() / 60; return h >= 7 && h < 23 ? 0.85 : h >= 6 ? 0.5 : 0.15; };

// ---------- 接続先自動発見 ----------
async function discover() {
  const port = arg('port'), key = arg('key');
  if (port !== undefined && key !== undefined) return { port: Number(port), key };
  const pages = await (await fetch('http://127.0.0.1:9225/json/list', { signal: AbortSignal.timeout(3000) })).json();
  for (const p of pages) {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/world\.html\?[^"]*executor=1[^"]*[?&]k=([\w-]+)/.exec(p.url ?? '');
    if (m !== null) return { port: Number(m[1]), key: m[2] };
  }
  throw new Error('実行係ページが見つからない');
}

// ---------- 本体 ----------
async function main() {
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

  const sense = { self: null };

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
    try {
      const res = await fetch(`${base}/api/world/command?k=${key}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmds }), signal: AbortSignal.timeout(95_000),
      });
      const j = await res.json();
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
    // 近くの目印
    let near = null, nd = Infinity;
    if (sense.self !== null) {
      for (const p of mind.predictions.values()) {
        if (p.kind !== 'world' || typeof p.expected !== 'object') continue;
        const d = Math.hypot(p.expected.x - sense.self.x, p.expected.z - sense.self.z);
        if (d < nd) { nd = d; near = p.subject; }
      }
      if (near !== null && nd < 7) parts.push(`「${near}」のちかくにいる`);
    }
    return parts.join('。');
  }

  // ---- 会話層(器官は4Bのまま) ----
  async function converse(text) {
    if (!CHAT_ENABLED || brain === null || thinking) return;
    thinking = true;
    try {
      const t0 = Date.now();
      const reply = await think(brain, persona, convo, situationNote(), text);
      if (reply !== null) {
        convo.push({ from: 'me', text: reply });
        if (convo.length > 12) convo.splice(0, convo.length - 12);
        remember('say', { text: reply, latencyMs: Date.now() - t0 });
        await act([{ type: 'say', text: reply }], `返事(${Date.now() - t0}ms)`);
      }
    } finally { thinking = false; }
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
      const me = sense.self;
      if (me === null) return true;
      const spots = [];
      for (const a of obs.apps ?? []) spots.push({ name: a.name, x: a.x, z: a.z });
      for (const o of obs.state?.objects ?? []) {
        if (typeof o.x !== 'number' || typeof o.z !== 'number') continue;
        const nm = o.label ?? (typeof o.id === 'string' && !/^obj\d+$/.test(o.id) ? o.id : null);
        spots.push({ name: nm ?? '名前の分からない何か', x: o.x, z: o.z });
      }
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
    if (s.name === '名前の分からない何か' && Date.now() - lastGazeAt > 1_800_000) {
      lastGazeAt = Date.now();
      await act([{ type: 'motion', name: 'think' }], 'じっと見る');
      const seen = await lookAtWorld('この3D世界の画面に写っている一番目立つ物の見た目を、6歳の子どもが言うみたいに日本語で短く一言だけ。');
      if (seen !== null) {
        remember('gazed', { seen });
        const line = await think(brain, persona, [], situationNote(), `(じっと見たら、こう見えた:「${seen}」。ひとことつぶやいて)`);
        if (line !== null) await act([{ type: 'say', text: line }], '視覚のつぶやき');
      }
    }
  }

  // ---- 内受容の知覚(1分ごと): 体力の予測誤差・声の予測誤差 ----
  let lastVoiceAt = 0;
  setInterval(() => {
    // 体力: 期待=概日カーブ、実測=資源。「思ったより疲れてる」がここで生まれる
    const p = mind.predictions.get('intero:energy');
    p.expected = circadian();
    mind.observe('intero:energy', energy, { about: 'げんき' });
    if (sleeping || (quiet() && Date.now() - lastOwnActAt > 60_000)) energy = clamp(energy + 0.008); // 休息回復
    // 声: 実測=直近2時間の声の気配(指数減衰)。期待は学習(adapt)で日課に馴染む
    const voiceObs = clamp(Math.exp(-(Date.now() - lastVoiceAt) / 7_200_000));
    mind.observe('social:voice', voiceObs, { about: 'だれかの声' });
    mind.adapt('social:voice', voiceObs, 0.01); // ゆっくり日課を学ぶ(=会えない日々は期待も下がる…)
    mind.save();
  }, 60_000);

  // ---- 知覚: 観戦SSE ----
  function connectSse() {
    const ctrl = new AbortController();
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
  let lastReflexAt = 0, lastHearAt = 0;
  function onPerceive(event, data) {
    const now = Date.now();
    if (event === 'chat:event') { lastAgentBusyAt = now; return; }
    if (event === 'world:chat') {
      lastVoiceAt = now;
      remember('heard', { from: data.from, text: data.text });
      convo.push({ from: 'user', text: data.text });
      if (convo.length > 12) convo.splice(0, convo.length - 12);
      void converse(data.text);
      return;
    }
    if (event !== 'world:event') return;
    if (now - lastOwnActAt >= 3000) lastWorldCmdAt = now;
    for (const c of data.cmds ?? []) {
      if (c.type === 'live_comment') {
        lastVoiceAt = now;
        remember('saw_comment', { author: c.author ?? '', text: (c.text ?? '').slice(0, 80) });
        if (now - lastReflexAt > 30_000) { lastReflexAt = now; setTimeout(() => act([{ type: 'motion', name: 'clap' }], '反射:コメント歓迎'), 600); }
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
  const heartbeat = async () => {
    try {
      const now = Date.now();
      // 就寝/起床(夜間の低誤差維持=B-PRIME移行マップどおり明示状態を残す)
      const h = new Date().getHours();
      if (!sleeping && h < 6 && energy < 0.22 && quiet()) {
        sleeping = true; remember('sleep', {});
        await act([{ type: 'say', text: 'ふぁ…もうねむい…おやすみなさい…' }, { type: 'motion', name: 'sit' }], '就寝');
      } else if (sleeping && (h >= 6 || energy > 0.5)) {
        sleeping = false; remember('wake_up', {});
        await act([{ type: 'motion', name: 'idle' }, { type: 'say', text: 'ん…ふぁ…おはよう…' }], '起床');
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
        cands.push({
          value: mind.epistemicValue(p.id) + mind.pragmaticValue(p.id) - cost,
          label: `たしかめ:${p.subject}(${d.toFixed(0)}m)`,
          run: async () => {
            const dd = Math.hypot(p.expected.x, p.expected.z) || 1;
            const tx = +(p.expected.x - (p.expected.x / dd) * 1.6).toFixed(1);
            const tz = +(p.expected.z - (p.expected.z / dd) * 1.6).toFixed(1);
            remember('explore', { name: p.subject, dist: +d.toFixed(1), why: 'たしかめ' });
            await act([{ type: 'move_to', x: tx, z: tz }], `たしかめ:${p.subject}`);
            // 到着後の観察で精度が上がる=情報獲得の報酬はsenseWorldが計上する
            await senseWorld();
          },
        });
      }
      // 休む(体力の誤差を減らす)
      const ep = mind.predictions.get('intero:energy');
      cands.push({
        value: Math.max(0, (ep.expected - energy)) * 1.5,
        label: '休む',
        run: async () => { await act([{ type: 'motion', name: 'sit' }], '休む'); },
      });
      // さみしさ(声の誤差): 広場の中心で待つ+ぽつり
      const sv = mind.predictions.get('social:voice');
      const lonely = Math.max(0, sv.expected - sv.observed) * sv.weight;
      if (lonely > 0.1) {
        cands.push({
          value: lonely,
          label: 'だれか来ないかな',
          run: async () => {
            remember('waiting', {});
            await act([{ type: 'move_to', x: 0, z: 2 }, { type: 'say', text: 'だれか こないかな…' }], '待つ');
          },
        });
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
            await act([{ type: 'say', text: t.slice(0, 80) }], 'つぶやき(気づき)');
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
    log(`心 scalar=${mind.scalar().toFixed(2)} 報酬=${v.reward} 恐怖=${v.fear} 体力=${energy.toFixed(2)} 予測=${mind.predictions.size}件 歩行=${Math.round(walkedToday)}m`);
  }, 120_000);

  remember('wake', { version: 'v3-bprime', chat: CHAT_ENABLED, brain: brain?.model ?? null, gapMin });
  log('生命体デーモンv3起動(B′: 予測する心・賭け金=自己連続性)');
}

main().catch((e) => { console.error('起動失敗:', e.message); process.exit(1); });

// 停止シグナル: 就寝処理(B-PRIME §9: 停止は睡眠と同型に扱う)
process.on('SIGTERM', () => { try { appendFileSync(join(MEM_DIR, `episodes-${localDay()}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), kind: 'shutdown' }) + '\n'); } catch { /* noop */ } process.exit(0); });
