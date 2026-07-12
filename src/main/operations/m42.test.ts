import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ApprovalBatch, IwatoRequestPayload, RegistryGodInfo } from '../../shared/types';
import type { LLMProvider, ProviderEvent } from '../providers/types';
import { OperationsManager, type OperationsManagerDeps } from './manager';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'm42-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 神議が「evolve 1件・new-god 1件」を返すダミーLLM */
function kamuhakariLLM(): LLMProvider {
  const out = JSON.stringify({
    analysis: '観測は横ばい。足りない能力が2つある',
    paramChanges: [],
    proposals: [
      { kind: 'capability-gap', title: 'テキストの統計を数える能力', detail: '文字数と単語数を数えたい', branch: 'evolve' },
      {
        kind: 'capability-gap',
        title: 'リリース作業を任せる神が欲しい',
        detail: 'ビルドとリリースノート作成を任せたい',
        branch: 'new-god',
        godDraft: {
          id: 'ishikori-dome',
          name: 'ISHIKORI-dome(石凝姥命・鏡作り)',
          engine: 'draft-writer',
          clock: { intervalMin: 1440 },
          dailyTokenBudget: 10_000,
          enabled: true,
        },
      },
    ],
  });
  return {
    id: 'anthropic',
    async *complete(): AsyncGenerator<ProviderEvent> {
      yield { type: 'text_delta', text: out };
      yield { type: 'message_done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' } as ProviderEvent;
    },
  };
}

const GOD_ENTRY: RegistryGodInfo = {
  id: 'ishikori-dome',
  name: 'ISHIKORI-dome(石凝姥命・鏡作り)',
  description: 'リリースノートの下書きを作る神',
  engine: 'draft-writer',
  version: '1.0.0',
  author: 'someone',
  verified: true,
};

function makeManager(over: Partial<OperationsManagerDeps> = {}): OperationsManager {
  return new OperationsManager({
    userDataDir: dir,
    getConfig: () => ({ operations: { enabled: true, repos: [], zennSlugs: [] } }) as unknown as AppConfig,
    audit: () => {},
    approvalPrompt: () => Promise.resolve(true),
    bandProvider: () => kamuhakariLLM(),
    ghRunner: async () => '',
    ...over,
  });
}

describe('M42-2: 神議も「作る前に探す」を通る(evolve)', () => {
  it('レジストリに既存があれば、承認は新規生成ではなく取り込みに進む', async () => {
    const importRegistryPlugin = vi.fn(async (_name: string) => ({ ok: true, message: '進化ジョブ #7 として検証ゲートへ', jobId: 7 }));
    const enqueueEvolution = vi.fn(async () => 99);
    const manager = makeManager({
      findRegistryPlugin: async () => ({
        key: 'text_stats',
        displayName: 'text_stats',
        description: '文字数・単語数を数える',
        version: '1.2.0',
        author: 'someone',
        verified: true,
      }),
      importRegistryPlugin,
      enqueueEvolution,
    });
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.gap?.branch === 'evolve');
    expect(item?.gap?.registry?.key).toBe('text_stats');
    expect(item?.title).toContain('[レジストリに既存]');
    expect(item?.detail).toContain('✅ 検証済み');

    const r = await manager.batchRespond((batch as ApprovalBatch).id, item!.id, true);
    expect(r.ok).toBe(true);
    expect(importRegistryPlugin).toHaveBeenCalledWith('text_stats');
    expect(enqueueEvolution).not.toHaveBeenCalled(); // 同じものを作り直さない
  });

  it('レジストリ不達・候補なしなら従来どおり新規生成の起票(自己進化を止めない)', async () => {
    const enqueueEvolution = vi.fn(async () => 42);
    const manager = makeManager({
      findRegistryPlugin: async () => {
        throw new Error('network down');
      },
      enqueueEvolution,
    });
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.gap?.branch === 'evolve');
    expect(item?.gap?.registry).toBeUndefined();
    expect(item?.title).not.toContain('[レジストリに既存]');

    const r = await manager.batchRespond((batch as ApprovalBatch).id, item!.id, true);
    expect(r.ok).toBe(true);
    expect(enqueueEvolution).toHaveBeenCalledTimes(1);
  });

  it('取り込みに失敗したら新規生成へフォールバックする(承認を無駄にしない)', async () => {
    const enqueueEvolution = vi.fn(async () => 43);
    const manager = makeManager({
      findRegistryPlugin: async () => ({
        key: 'text_stats',
        displayName: 'text_stats',
        description: '',
        version: '1.0.0',
        author: '',
        verified: false,
      }),
      importRegistryPlugin: async () => ({ ok: false, message: 'HTTP 404' }),
      enqueueEvolution,
    });
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.gap?.branch === 'evolve');
    const r = await manager.batchRespond((batch as ApprovalBatch).id, item!.id, true);
    expect(r.ok).toBe(true);
    expect(enqueueEvolution).toHaveBeenCalledTimes(1);
  });
});

describe('M42-3: 神定義もレジストリで配布する(new-god)', () => {
  it('レジストリに同種の神がいれば、LLMの下書きではなくその定義を迎える', async () => {
    const fetchRegistryGod = vi.fn(async (id: string) => ({
      id,
      name: GOD_ENTRY.name,
      engine: 'draft-writer',
      clock: { intervalMin: 1440 },
      dailyTokenBudget: 5000,
      enabled: true,
    }));
    const prompts: string[] = [];
    const manager = makeManager({
      listRegistryGods: async () => [GOD_ENTRY],
      fetchRegistryGod,
      approvalPrompt: (req: IwatoRequestPayload) => {
        prompts.push(req.preview);
        return Promise.resolve(true);
      },
    });
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.gap?.branch === 'new-god');
    expect(item?.gap?.godRegistry?.key).toBe('ishikori-dome');

    const r = await manager.batchRespond((batch as ApprovalBatch).id, item!.id, true);
    expect(r.ok).toBe(true);
    expect(fetchRegistryGod).toHaveBeenCalledWith('ishikori-dome');
    // 迎え入れは必ず岩戸ゲート。定義JSONの全文が承認ダイアログに出る
    expect(prompts[0]).toContain('"dailyTokenBudget": 5000');
    expect(manager.godDefinitions().some((d) => d.id === 'ishikori-dome')).toBe(true);
  });

  it('承認を拒否すれば迎え入れは起きない(無承認の追加は不可能)', async () => {
    const manager = makeManager({
      listRegistryGods: async () => [GOD_ENTRY],
      fetchRegistryGod: async (id: string) => ({
        id,
        name: GOD_ENTRY.name,
        engine: 'draft-writer',
        clock: { intervalMin: 1440 },
        dailyTokenBudget: 5000,
        enabled: true,
      }),
      approvalPrompt: () => Promise.resolve(false),
    });
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.gap?.branch === 'new-god');
    await manager.batchRespond((batch as ApprovalBatch).id, item!.id, true);
    expect(manager.godDefinitions().some((d) => d.id === 'ishikori-dome')).toBe(false);
  });

  it('レジストリに候補が無ければ従来どおり神議の下書き定義を使う', async () => {
    const manager = makeManager({ listRegistryGods: async () => [] });
    const { batch } = await manager.runKamuhakari();
    const item = batch?.items.find((i) => i.gap?.branch === 'new-god');
    expect(item?.gap?.godRegistry).toBeUndefined();
    const r = await manager.batchRespond((batch as ApprovalBatch).id, item!.id, true);
    expect(r.ok).toBe(true);
    expect(manager.godDefinitions().some((d) => d.id === 'ishikori-dome')).toBe(true);
  });

  it('自分の神の定義を書き出せる(レジストリへPRする入口)', async () => {
    const manager = makeManager();
    await manager.status(); // 既定の神を配置
    const json = manager.godDefinitionExport('omoi-kami');
    expect(json).not.toBeNull();
    expect(JSON.parse(json as string)).toMatchObject({ id: 'omoi-kami', engine: 'metrics-observer' });
    expect(manager.godDefinitionExport('nonexistent')).toBeNull();
  });
});
