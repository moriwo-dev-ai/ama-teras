import { describe, expect, it, vi } from 'vitest';
import { createBlueskyAdapter } from './adapters/bluesky';
import { createGithubAdapter } from './adapters/github';
import { createXAdapter } from './adapters/x';
import { createZennAdapter } from './adapters/zenn';
import { IwatoGate, type AdapterRuntime, type IwatoAuditEvent } from './protocol';

/**
 * M32-2: 岩戸ゲートの掟をテストで固定する。
 * - 承認なし実行はコードレベルで不可能(executorは登録時に封印される)
 * - 承認が拒否されたら executor に到達しない
 * - capabilities.execute の宣言と実挙動(executor有無)の一致を登録時に強制
 * - 全実行(拒否含む)が audit に残る
 */

function makeAdapter(overrides: Partial<AdapterRuntime> = {}): AdapterRuntime {
  return {
    id: 'test',
    capabilities: { read: true, search: false, draft: false, execute: ['post'] },
    compliance: 'テスト用',
    executor: vi.fn().mockResolvedValue('posted'),
    ...overrides,
  };
}

describe('IwatoGate(岩戸ゲート)', () => {
  it('承認されたら実行され、auditに approved=true が残る', async () => {
    const audits: IwatoAuditEvent[] = [];
    const gate = new IwatoGate(
      () => Promise.resolve(true),
      (e) => audits.push(e),
    );
    const exec = vi.fn().mockResolvedValue('done');
    gate.register(makeAdapter({ executor: exec }));

    const result = await gate.requestExecute('test', 'post', 'X/@someone', '本文プレビュー', {});
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('post', {});
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ adapterId: 'test', action: 'post', approved: true });
  });

  it('承認が拒否されたら executor に一切到達せず、auditに approved=false が残る', async () => {
    const audits: IwatoAuditEvent[] = [];
    const gate = new IwatoGate(
      () => Promise.resolve(false),
      (e) => audits.push(e),
    );
    const exec = vi.fn();
    gate.register(makeAdapter({ executor: exec }));

    const result = await gate.requestExecute('test', 'post', 'target', 'preview', {});
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ approved: false });
  });

  it('宣言していないアクションは承認ダイアログにすら出さず拒否する', async () => {
    const prompt = vi.fn().mockResolvedValue(true);
    const audits: IwatoAuditEvent[] = [];
    const gate = new IwatoGate(prompt, (e) => audits.push(e));
    gate.register(makeAdapter());

    const result = await gate.requestExecute('test', 'delete-everything', 'target', 'p', {});
    expect(result.ok).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({ approved: false });
  });

  it('登録時に executor 参照が呼び出し元のオブジェクトからも消える(封印)', () => {
    const gate = new IwatoGate(
      () => Promise.resolve(true),
      () => {},
    );
    const runtime = makeAdapter();
    gate.register(runtime);
    expect(runtime.executor).toBeUndefined();
    // list() で返る宣言にも executor は存在しない
    const listed = gate.list()[0] as unknown as Record<string, unknown>;
    expect(listed['executor']).toBeUndefined();
  });

  it('execute宣言あり×executor無しは登録拒否(実行できない宣言は嘘)', () => {
    const gate = new IwatoGate(
      () => Promise.resolve(true),
      () => {},
    );
    const bad = makeAdapter();
    delete bad.executor;
    expect(() => gate.register(bad)).toThrow(/executor が無い/);
  });

  it('execute宣言なし×executorありは登録拒否(宣言外の実行能力=闇ルート)', () => {
    const gate = new IwatoGate(
      () => Promise.resolve(true),
      () => {},
    );
    const bad = makeAdapter({ capabilities: { read: true, search: false, draft: false, execute: [] } });
    expect(() => gate.register(bad)).toThrow(/executor を持っている/);
  });

  it('executor が例外を投げても ok:false で返り、auditに実行失敗が残る', async () => {
    const audits: IwatoAuditEvent[] = [];
    const gate = new IwatoGate(
      () => Promise.resolve(true),
      (e) => audits.push(e),
    );
    gate.register(makeAdapter({ executor: vi.fn().mockRejectedValue(new Error('rate limit')) }));
    const result = await gate.requestExecute('test', 'post', 't', 'p', {});
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('rate limit');
    expect(audits[0]?.detail).toContain('実行失敗');
  });
});

describe('初期アダプタの宣言と実挙動の一致', () => {
  it('x: execute は空配列(すべて人間が実行)で、executor を持たない', () => {
    const x = createXAdapter();
    expect(x.capabilities.execute).toEqual([]);
    expect(x.executor).toBeUndefined();
    // ゲートに登録でき、どんなexecuteも拒否される
    const gate = new IwatoGate(
      () => Promise.resolve(true),
      () => {},
    );
    gate.register(x);
  });

  it('zenn / bluesky: 読み取り系のみで executor を持たない', () => {
    for (const adapter of [createZennAdapter(), createBlueskyAdapter()]) {
      expect(adapter.capabilities.execute).toEqual([]);
      expect(adapter.executor).toBeUndefined();
    }
  });

  it('github: comment/label/merge/release を宣言し、executor は宣言外アクションを拒否する', async () => {
    const run = vi.fn().mockResolvedValue('');
    const adapter = createGithubAdapter(run, () => true);
    // M37: release(リリースノート下書きの行き先)を追加
    expect(adapter.capabilities.execute).toEqual(['comment', 'label', 'merge', 'release']);
    expect(adapter.executor).toBeDefined();
    await expect(adapter.executor!('follow', {})).rejects.toThrow(/未知のアクション/);
  });

  it('github executor: comment が gh の該当コマンドに写像される(モック・実発行なし)', async () => {
    const run = vi.fn().mockResolvedValue('');
    const adapter = createGithubAdapter(run, () => true);
    const gate = new IwatoGate(
      () => Promise.resolve(true),
      () => {},
    );
    gate.register(adapter);
    const result = await gate.requestExecute('github', 'comment', 'o/r#1', '返信本文', {
      repo: 'o/r',
      number: 1,
      kind: 'issue',
      body: '返信本文',
    });
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledWith(['issue', 'comment', '1', '-R', 'o/r', '--body', '返信本文']);
  });
});
