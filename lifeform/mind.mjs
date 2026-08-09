/**
 * B′中核: 予測する心 (2026-08-09深夜, B-PRIME.md §1,§6)
 *
 * 原理: 壊れうる自己モデルを、予測によって維持し続けるシステム。
 * - 自己モデル = 予測の束(このファイルが管理する predictions)
 * - 中心軸 = 一つのスカラー: 精度重み付き予測誤差(=彼女の「調子」)
 * - 報酬 = 誤差が良い方向に減った / 恐怖 = 生存関連の大誤差が予測される状態
 * - 行動価値 = 期待誤差減(実利)+精度改善期待(好奇心)。行動は書かない、導出する
 *
 * 旧drives(退屈・社交欲・好奇心・元気)はここから導出されるため廃止された。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * 予測 = { id, kind: 'intero'|'world'|'social', subject, expected, observed,
 *          precision(0..1 確信度), weight(生存関連度=誤差の重み), lastConfirmAt, origin }
 * expected/observed は 0..1 に正規化した量、または {x,z}(worldの位置予測)。
 */
export class Mind {
  constructor(path, now = () => Date.now()) {
    this.path = path;
    this.now = now;
    this.predictions = new Map();
    this.valenceLog = []; // {ts, kind:'reward'|'fear'|'surprise', amount, about}
    this.prevScalar = null;
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      for (const p of data.predictions ?? []) this.predictions.set(p.id, p);
    } catch { /* 最初の心は空 */ }
  }

  save() {
    try {
      writeFileSync(this.path, JSON.stringify({ predictions: [...this.predictions.values()] }, null, 1));
    } catch { /* 保存失敗で心は止めない */ }
  }

  /** 予測を持つ(なければ作る)。originは出所監査用('innate'|'learned'|'told') */
  ensure(id, init) {
    if (!this.predictions.has(id)) {
      this.predictions.set(id, {
        id, kind: init.kind, subject: init.subject,
        expected: init.expected, observed: init.expected,
        precision: init.precision ?? 0.3, weight: init.weight ?? 0.5,
        lastConfirmAt: this.now(), origin: init.origin ?? 'learned',
      });
    }
    return this.predictions.get(id);
  }

  /** 観測を照合する=知覚の本体。返り値は符号付きサプライズ(正=予測より良い/負=悪い) */
  observe(id, observed, opts = {}) {
    const p = this.predictions.get(id);
    if (p === undefined) return 0;
    const before = this.errorOf(p);
    p.observed = observed;
    p.lastConfirmAt = this.now();
    const after = this.errorOf(p);
    // 予測が当たった→精度が上がる。外れた→精度が下がる(次からその対象に注意が向く)
    p.precision = clamp01(p.precision + (after < 0.15 ? 0.06 : -Math.min(0.3, after * 0.5)));
    const delta = before - after; // 正=誤差が減った
    if (Math.abs(delta) > 0.08) {
      this.valenceLog.push({
        ts: this.now(),
        kind: delta > 0 ? 'reward' : (p.weight > 0.6 ? 'fear' : 'surprise'),
        amount: +Math.abs(delta * p.weight).toFixed(3),
        about: opts.about ?? p.subject,
      });
      if (this.valenceLog.length > 200) this.valenceLog.splice(0, this.valenceLog.length - 200);
    }
    return delta;
  }

  /** 期待の側を静かに更新する(学習: 世界に合わせてモデルを直す)。率は精度に反比例 */
  adapt(id, towards, rate = null) {
    const p = this.predictions.get(id);
    if (p === undefined || typeof p.expected !== 'number' || typeof towards !== 'number') return;
    const r = rate ?? (1 - p.precision) * 0.15;
    p.expected = p.expected + (towards - p.expected) * r;
  }

  errorOf(p) {
    if (typeof p.expected === 'number' && typeof p.observed === 'number') {
      return Math.abs(p.expected - p.observed);
    }
    if (p.expected !== null && typeof p.expected === 'object' && p.observed !== null && typeof p.observed === 'object') {
      // 位置予測: 誤差を距離で(8mで飽和)
      return Math.min(1, Math.hypot(p.expected.x - p.observed.x, p.expected.z - p.observed.z) / 8);
    }
    return 0;
  }

  /** 中心軸スカラー(0=完全な調和, 1=総崩れ)。時間経過で精度も静かに減衰させる(見ていない世界は不確かになる) */
  scalar() {
    let sum = 0, wsum = 0;
    const now = this.now();
    for (const p of this.predictions.values()) {
      const staleDays = (now - p.lastConfirmAt) / 86_400_000;
      if (staleDays > 0.02) p.precision = clamp01(p.precision - staleDays * 0.004); // 精度の自然減衰
      sum += this.errorOf(p) * p.weight * (0.3 + p.precision * 0.7);
      wsum += p.weight;
    }
    return wsum > 0 ? sum / wsum : 0;
  }

  /** 報酬と恐怖の読み出し(直近windowMsの合算。恐怖は2倍重い=損失回避の非対称) */
  valence(windowMs = 300_000) {
    const cut = this.now() - windowMs;
    let reward = 0, fear = 0;
    for (const v of this.valenceLog) {
      if (v.ts < cut) continue;
      if (v.kind === 'reward') reward += v.amount;
      else fear += v.amount * (v.kind === 'fear' ? 2 : 1);
    }
    return { reward: +reward.toFixed(3), fear: +fear.toFixed(3) };
  }

  /**
   * 行動価値 = 実利(その行動が減らすと期待される誤差×重み)+好奇心(精度の低い対象を
   * 確かめることによる情報獲得)。候補は呼び出し側が列挙し、ここは値付けだけを行う。
   */
  epistemicValue(id) {
    const p = this.predictions.get(id);
    if (p === undefined) return 0;
    const stale = Math.min(1, (this.now() - p.lastConfirmAt) / 3_600_000 / 6); // 6時間で飽和
    return (1 - p.precision) * 0.6 + stale * 0.4;
  }

  pragmaticValue(id) {
    const p = this.predictions.get(id);
    if (p === undefined) return 0;
    return this.errorOf(p) * p.weight;
  }

  /** 気分の言語化材料(会話層・内省へ渡す。LLMへの狭い帯域) */
  moodNote() {
    const s = this.scalar();
    const { reward, fear } = this.valence();
    const parts = [];
    if (fear > 0.15) parts.push('なんだか胸がざわざわする');
    else if (reward > 0.2) parts.push('いいことがあった気がして嬉しい');
    if (s < 0.15) parts.push('世界がぜんぶ思ったとおりで、しずか');
    else if (s > 0.45) parts.push('わからないことだらけで落ち着かない');
    // 一番気になっている(=精度が低い×重い)予測
    let worst = null, wv = 0;
    for (const p of this.predictions.values()) {
      const v = this.errorOf(p) * p.weight + this.epistemicValue(p.id) * 0.3;
      if (v > wv) { wv = v; worst = p; }
    }
    if (worst !== null && wv > 0.3) parts.push(`「${worst.subject}」のことが気にかかる`);
    return parts.join('。');
  }
}
