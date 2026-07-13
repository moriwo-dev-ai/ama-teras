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
