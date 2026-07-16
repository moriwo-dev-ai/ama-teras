import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EvolutionJobSummary } from '../../shared/types';
import { JobStore } from './jobStore';

/**
 * M52: 進化ジョブの履歴は**メモリ上のMapだけ**にあった。再起動で進化タブは空になり、
 * 「ジョブ16がゲートで落ちた」という事実そのものが消えていた(実害)。
 */
let dir: string;
let file: string;

const job = (over: Partial<EvolutionJobSummary> = {}): EvolutionJobSummary => ({
  id: 1,
  description: 'テスト',
  status: 'done',
  log: [],
  gates: [],
  ...over,
});

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-jobstore-'));
  file = join(dir, 'evolution', 'jobs.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('M52: 進化ジョブ履歴の永続化', () => {
  it('保存して読み戻せる(失敗の理由と落ちたゲートも残る)', async () => {
    const store = new JobStore(file);
    await store.save([
      job({ id: 16, status: 'failed', error: 'vitest 不合格', gates: [{ name: 'vitest', ok: false, detail: 'timeout' }] }),
    ]);

    const [restored] = await store.load();

    expect(restored!.id).toBe(16);
    expect(restored!.status).toBe('failed');
    expect(restored!.error).toBe('vitest 不合格');
    expect(restored!.gates[0]!.name).toBe('vitest');
  });

  it('前回の終了で中断された「実行中」ジョブは failed として復元する(永遠に走り続けて見えないように)', async () => {
    const store = new JobStore(file);
    await store.save([job({ id: 3, status: 'generating' })]);

    const restored = await store.load();

    expect(restored.map((j) => j.status)).toEqual(['failed']);
    expect(restored[0]!.error).toContain('中断');
  });

  /**
   * M70: 全ゲートを通過して人間の承認だけを待っていたジョブを、「中断された」と一括りにして
   * いた。中断されたのは待機だけで、生成物はブランチに残っている。捨てるしかない失敗と、
   * 拾い直せる失敗を混ぜない
   */
  it('昇格の承認待ちだったジョブは、成果がブランチに残っていることを理由に書く', async () => {
    const store = new JobStore(file);
    await store.save([job({ id: 16, status: 'awaiting_promotion' })]);

    const [restored] = await store.load();

    expect(restored!.status).toBe('failed');
    expect(restored!.error).toContain('evolve/job-16');
    expect(restored!.error).toContain('検証ゲートは全て通過');
  });

  it('ログは末尾40行だけ残す(生成ログは長い。結論に近い側を残す)', async () => {
    const store = new JobStore(file);
    const log = Array.from({ length: 100 }, (_, i) => `line-${i}`);
    await store.save([job({ log })]);

    const [restored] = await store.load();

    expect(restored!.log).toHaveLength(40);
    expect(restored!.log.at(-1)).toBe('line-99');
  });

  it('ファイルが壊れていても進化は止めない(履歴は補助情報)', async () => {
    await new JobStore(file).save([job()]); // ディレクトリを作らせる
    await writeFile(file, '{壊れたJSON', 'utf8');

    await expect(new JobStore(file).load()).resolves.toEqual([]);
  });

  it('保存先が無ければ作る', async () => {
    await new JobStore(file).save([job({ id: 9 })]);

    expect(JSON.parse(await readFile(file, 'utf8'))[0].id).toBe(9);
  });
});

/**
 * 実害(2026-07-17): core昇格(#38)の再起動時、直列化されていない save が重なって
 * jobs.json が「正しいJSONの後ろに残骸」の引き裂かれた状態になり、履歴38件が全部消えた。
 */
describe('引き裂かれたファイルからの回収とアトミック保存', () => {
  it('正しいJSONの後ろに書き込み残骸が付いたファイルでも、履歴を回収できる', async () => {
    const store = new JobStore(file);
    await store.save([job({ id: 38, status: 'done' }), job({ id: 37, status: 'rejected' })]);
    // 実際に起きた壊れ方を再現: 短い書き込みが長い旧内容を切詰めずに上書き → 末尾に残骸
    const good = await readFile(file, 'utf8');
    await writeFile(file, good + '\n }\n]', 'utf8');

    const restored = await new JobStore(file).load();

    expect(restored.map((j) => j.id).sort()).toEqual([37, 38]);
  });

  it('回収も不可能な壊れ方は従来どおり履歴なしで進む', async () => {
    await new JobStore(file).save([job()]);
    await writeFile(file, 'garbage-not-json-at-all', 'utf8');
    await expect(new JobStore(file).load()).resolves.toEqual([]);
  });

  it('並行saveが重なってもファイルは常に完全なJSON(直列化+tmp→rename)', async () => {
    const store = new JobStore(file);
    // fire-and-forget と同じ呼び方で10連発(旧実装ではこれで引き裂かれ得た)
    const jobs = Array.from({ length: 10 }, (_, i) => job({ id: i + 1, log: Array(30).fill(`x-${i}`) }));
    await Promise.all(jobs.map((_, i) => store.save(jobs.slice(0, i + 1))));

    const raw = await readFile(file, 'utf8');
    const parsed = JSON.parse(raw); // 引き裂かれていれば throw
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(10); // 最後の save(全10件)が最終状態
  });
});
