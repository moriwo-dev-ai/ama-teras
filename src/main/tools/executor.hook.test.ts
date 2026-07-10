import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../agent/approval';
import { executeToolWithApproval, runPostEditHook, type ExecutorDeps } from './executor';
import type { ToolContext, ToolPlugin } from './types';

/** M11-4: 編集後フック(postEditHook)のテスト */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-hook-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function fakePlugin(name: string, risk: 'safe' | 'write'): ToolPlugin {
  return {
    name,
    description: 'テスト用',
    risk,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: `${name} 完了` }),
  };
}

function deps(hookCommand: string | null, plugin: ToolPlugin): ExecutorDeps {
  return {
    registry: { get: (n) => (n === plugin.name ? plugin : undefined) },
    broker: new ApprovalBroker(() => {}),
    getAutoApprove: () => ({ safe: true, write: true, exec: true }),
    ...(hookCommand !== null
      ? { getPostEditHook: () => ({ command: hookCommand, cwd: dir }) }
      : {}),
  };
}

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, log: () => {}, ...overrides };
}

describe('編集後フック(M11-4)', () => {
  it('write_file 成功後にフックが実行され、出力が tool_result に追記される', async () => {
    const plugin = fakePlugin('write_file', 'write');
    const r = await executeToolWithApproval(
      deps(`node -e "console.log('hook-ok')"`, plugin),
      'write_file',
      {},
      ctx(),
    );
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain('write_file 完了');
    expect(r.content).toContain('[post-edit hook]');
    expect(r.content).toContain('hook-ok');
  });

  it('フックが non-zero でもツール結果は成功のまま(情報として追記)', async () => {
    const plugin = fakePlugin('edit_file', 'write');
    const r = await executeToolWithApproval(
      deps(`node -e "console.error('lint NG'); process.exit(1)"`, plugin),
      'edit_file',
      {},
      ctx(),
    );
    expect(r.isError).not.toBe(true);
    expect(r.content).toContain('lint NG');
    expect(r.content).toContain('フック exit code: 1');
  });

  it('未設定(getPostEditHook なし)なら何も実行されず追記もない', async () => {
    const plugin = fakePlugin('write_file', 'write');
    const r = await executeToolWithApproval(deps(null, plugin), 'write_file', {}, ctx());
    expect(r.content).toBe('write_file 完了');
  });

  it('write_file / edit_file 以外のツールでは実行されない', async () => {
    const marker = join(dir, 'hook-ran.txt');
    const plugin = fakePlugin('read_file', 'safe');
    const r = await executeToolWithApproval(
      deps(`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', '1')"`, plugin),
      'read_file',
      {},
      ctx(),
    );
    expect(r.content).toBe('read_file 完了');
    expect(existsSync(marker)).toBe(false);
  });

  it('restrictExec コンテキスト(進化ジョブ)では注入されていても実行しない', async () => {
    const marker = join(dir, 'hook-ran.txt');
    const plugin = fakePlugin('write_file', 'write');
    const r = await executeToolWithApproval(
      deps(`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', '1')"`, plugin),
      'write_file',
      {},
      ctx({ restrictExec: true }),
    );
    expect(r.content).toBe('write_file 完了');
    expect(existsSync(marker)).toBe(false);
  });

  it('ツールがエラーのときはフックを実行しない', async () => {
    const marker = join(dir, 'hook-ran.txt');
    const plugin: ToolPlugin = {
      ...fakePlugin('write_file', 'write'),
      execute: async () => ({ content: '失敗', isError: true }),
    };
    const r = await executeToolWithApproval(
      deps(`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '/')}', '1')"`, plugin),
      'write_file',
      {},
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('runPostEditHook 単体', () => {
  it('タイムアウトで打ち切られて必ず戻る(テスト用に短縮)', async () => {
    const out = await runPostEditHook(
      `node -e "setTimeout(() => {}, 10000)"`,
      dir,
      new AbortController().signal,
      300,
    );
    // シェルが即死すれば「シグナル」、孫プロセスが stdio を握ればフォールバックの「タイムアウト」
    expect(out).toMatch(/シグナル|タイムアウト/);
  }, 5_000);

  it('長い出力は末尾4KBに切り詰められる', async () => {
    const out = await runPostEditHook(
      `node -e "process.stdout.write('x'.repeat(10000) + 'TAIL-MARKER')"`,
      dir,
      new AbortController().signal,
    );
    expect(out).toContain('TAIL-MARKER');
    expect(out).toContain('先頭切り詰め');
    expect(out.length).toBeLessThan(5000);
  });

  it('起動できないコマンドでも例外にならずメッセージを返す', async () => {
    const out = await runPostEditHook(
      'definitely-no-such-command-xyz',
      dir,
      new AbortController().signal,
      5000,
    );
    // shell 経由では non-zero exit、spawn 直接失敗なら起動エラーのどちらか
    expect(out).toMatch(/exit code|起動エラー/);
  });
});
