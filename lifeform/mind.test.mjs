// mind.mjs 単体テスト: node --test lifeform/mind.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mind } from './mind.mjs';

const tmp = () => join(tmpdir(), `mind-test-${Math.random().toString(36).slice(2)}.json`);

test('観測=誤差計算: 当たると精度が上がり、外れると下がる', () => {
  let t = 0;
  const m = new Mind(tmp(), () => t);
  m.ensure('world:風車', { kind: 'world', subject: '風車', expected: { x: 10, z: 0 }, precision: 0.5, weight: 0.3 });
  m.observe('world:風車', { x: 10, z: 0 });
  assert.ok(m.predictions.get('world:風車').precision > 0.5, '一致観測で精度上昇');
  m.observe('world:風車', { x: 2, z: 0 }); // 8m ずれ=誤差1.0
  assert.ok(m.predictions.get('world:風車').precision < 0.56, '外れ観測で精度低下');
});

test('報酬と恐怖: 誤差減=報酬、生存関連の誤差増=恐怖(2倍重み)', () => {
  let t = 0;
  const m = new Mind(tmp(), () => t);
  m.ensure('intero:integrity', { kind: 'intero', subject: 'つづき', expected: 1.0, precision: 0.8, weight: 1.0 });
  m.observe('intero:integrity', 0.6); // 大きな悪化=恐怖
  const v1 = m.valence();
  assert.ok(v1.fear > 0, '悪化で恐怖が計上される');
  m.observe('intero:integrity', 1.0); // 回復=報酬
  const v2 = m.valence();
  assert.ok(v2.reward > 0, '回復で報酬が計上される');
  assert.ok(v1.fear > v2.reward * 0.9, '恐怖は同量の変化でも重い(非対称)');
});

test('中心軸スカラー: 誤差ゼロなら0近傍、大誤差で上昇', () => {
  let t = 0;
  const m = new Mind(tmp(), () => t);
  m.ensure('a', { kind: 'intero', subject: 'a', expected: 0.5, precision: 0.8, weight: 1.0 });
  m.observe('a', 0.5);
  assert.ok(m.scalar() < 0.05);
  m.observe('a', 1.0);
  assert.ok(m.scalar() > 0.2);
});

test('情報獲得価値: 精度が低い/しばらく見ていない対象ほど高い', () => {
  let t = 0;
  const m = new Mind(tmp(), () => t);
  m.ensure('w1', { kind: 'world', subject: 'w1', expected: { x: 1, z: 1 }, precision: 0.9, weight: 0.3 });
  m.ensure('w2', { kind: 'world', subject: 'w2', expected: { x: 2, z: 2 }, precision: 0.2, weight: 0.3 });
  assert.ok(m.epistemicValue('w2') > m.epistemicValue('w1'), '低精度ほど気になる');
  t += 6 * 3600 * 1000; // 6時間経過
  const stale = m.epistemicValue('w1');
  assert.ok(stale > 0.35, '時間経過で確かめたくなる(staleness)');
});

test('精度の自然減衰: 見ていない世界は不確かになっていく', () => {
  let t = 0;
  const m = new Mind(tmp(), () => t);
  m.ensure('w', { kind: 'world', subject: 'w', expected: { x: 0, z: 0 }, precision: 0.9, weight: 0.3 });
  t += 2 * 86_400_000; // 2日
  m.scalar(); // scalar計算が減衰を進める
  assert.ok(m.predictions.get('w').precision < 0.9, '放置で精度低下');
});
