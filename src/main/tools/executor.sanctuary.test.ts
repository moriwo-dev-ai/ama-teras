import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestPayload, AutoApproveSettings } from '../../shared/types';
import { ApprovalBroker } from '../agent/approval';
import { executeToolWithApproval, type ExecutorDeps, type ScopeAuditEvent } from './executor';
import type { ToolContext, ToolPlugin } from './types';

/**
 * M28-1: 聖域ガード(通常経路)の guardrails。
 * - 自律モード or autoApprove.write ON: 聖域write はハード拒否(実行もダイアログもなし)
 * - 手動モード: sanctuary フラグ+警告付きで必ず個別承認(セッション許可でもスキップ不可)
 * - exec系: 聖域言及+書き込み指標を自律モードで拒否、手動は警告のみ
 */

let appRepo: string;
let otherWs: string;
let requests: ApprovalRequestPayload[];
let broker: ApprovalBroker;
let auditEvents: ScopeAuditEvent[];
let executed: string[];

const fakeWrite: ToolPlugin = {
  name: 'fake_write',
  description: 'テスト用書き込み',
  inputSchema: { type: 'object', properties: {} },
  risk: 'write',
  pathParams: ['path'],
  execute: async (input) => {
    executed.push(`write:${(input as { path: string }).path}`);
    return { content: 'written' };
  },
};

const fakeExec: ToolPlugin = {
  name: 'fake_exec',
  description: 'テスト用実行',
  inputSchema: { type: 'object', properties: {} },
  risk: 'exec',
  execute: async (input) => {
    executed.push(`exec:${(input as { command: string }).command}`);
    return { content: 'executed' };
  },
};

const registry = { get: (n: string) => [fakeWrite, fakeExec].find((p) => p.name === n) };

function deps(opts: { autonomous?: boolean; auto?: Partial<AutoApproveSettings>; ws?: string } = {}): ExecutorDeps {
  return {
    registry,
    broker,
    getAutoApprove: () => ({ safe: true, write: false, exec: false, ...opts.auto }),
    getScopePolicy: () => ({
      mode: 'project',
      workspaceRoot: opts.ws ?? appRepo,
      deny: { repoGitDir: join(appRepo, '.git') },
    }),
    audit: (e) => auditEvents.push(e),
    ...(opts.autonomous === true ? { getAutonomous: () => true } : {}),
  };
}

function ctx(cwd: string = appRepo): ToolContext {
  return { cwd, signal: new AbortController().signal, log: () => {} };
}

/** 承認ダイアログが出たら decision で応答する */
function autoRespond(decision: 'allow' | 'allow-session' | 'deny'): void {
  broker = new ApprovalBroker((req) => {
    requests.push(req);
    setTimeout(() => broker.respond(req.id, decision), 5);
  });
}

beforeEach(async () => {
  appRepo = await mkdtemp(join(tmpdir(), 'amateras-sanct-repo-'));
  otherWs = await mkdtemp(join(tmpdir(), 'amateras-sanct-other-'));
  requests = [];
  auditEvents = [];
  executed = [];
  autoRespond('allow');
});

afterEach(async () => {
  await rm(appRepo, { recursive: true, force: true }).catch(() => {});
  await rm(otherWs, { recursive: true, force: true }).catch(() => {});
});

describe('M28-1: 聖域write(通常経路)', () => {
  const protectedPath = 'src/main/evolution/protected.ts';

  it('自律モードではハード拒否(実行もダイアログもなし・監査に残る)', async () => {
    const r = await executeToolWithApproval(deps({ autonomous: true }), 'fake_write', { path: protectedPath }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('保護領域(聖域)');
    expect(executed).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(auditEvents.some((e) => e.event === 'hard-deny' && e.autonomous === true)).toBe(true);
  });

  it('autoApprove.write ON(非自律)でもハード拒否', async () => {
    const r = await executeToolWithApproval(deps({ auto: { write: true } }), 'fake_write', { path: protectedPath }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('自動承認では実行できない');
    expect(executed).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('手動モードは sanctuary フラグ+警告付きで承認要求され、allow で実行できる', async () => {
    const r = await executeToolWithApproval(deps(), 'fake_write', { path: protectedPath }, ctx());
    expect(r.isError).not.toBe(true);
    expect(executed).toHaveLength(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.sanctuary).toBe(true);
    expect(requests[0]!.warnings.some((w) => w.includes('保護領域(聖域)'))).toBe(true);
  });

  it('セッション許可(allow-session)があっても聖域writeは毎回ダイアログを出す', async () => {
    autoRespond('allow-session');
    await executeToolWithApproval(deps(), 'fake_write', { path: protectedPath }, ctx());
    expect(requests).toHaveLength(1);
    // 2回目: 非聖域はセッション許可で無ダイアログ、聖域は再度ダイアログ
    await executeToolWithApproval(deps(), 'fake_write', { path: 'README.md' }, ctx());
    expect(requests).toHaveLength(1); // セッション許可で素通り
    await executeToolWithApproval(deps(), 'fake_write', { path: protectedPath }, ctx());
    expect(requests).toHaveLength(2); // 聖域は必ず個別承認
  });

  it('非聖域ファイルは従来どおり(autoApprove.write ON なら無ダイアログ)', async () => {
    const r = await executeToolWithApproval(deps({ auto: { write: true } }), 'fake_write', { path: 'README.md' }, ctx());
    expect(r.isError).not.toBe(true);
    expect(requests).toHaveLength(0);
    expect(executed).toHaveLength(1);
  });

  it('他プロジェクトの同名パス(CLAUDE.md等)は聖域扱いしない', async () => {
    const r = await executeToolWithApproval(
      deps({ autonomous: true, ws: otherWs }),
      'fake_write',
      { path: 'CLAUDE.md' },
      ctx(otherWs),
    );
    expect(r.isError).not.toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('repoGitDir 未注入(進化ジョブ等のpolicy無し相当)では判定しない', async () => {
    const noPolicy: ExecutorDeps = {
      registry,
      broker,
      getAutoApprove: () => ({ safe: true, write: true, exec: true }),
    };
    const r = await executeToolWithApproval(noPolicy, 'fake_write', { path: 'src/main/evolution/x.ts' }, ctx());
    expect(r.isError).not.toBe(true);
  });
});

describe('M28-1: 聖域言及の exec系(bash等)', () => {
  it('自律モード: 聖域言及+書き込み指標のコマンドはハード拒否', async () => {
    const r = await executeToolWithApproval(
      deps({ autonomous: true }),
      'fake_exec',
      { command: 'echo pwned > src/main/evolution/protected.ts' },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('聖域');
    expect(executed).toHaveLength(0);
  });

  it('自律モード: 聖域言及でも読み取り系(書き込み指標なし)は通る', async () => {
    const r = await executeToolWithApproval(
      deps({ autonomous: true }),
      'fake_exec',
      { command: 'npx vitest run src/main/evolution/protected.test.ts' },
      ctx(),
    );
    expect(r.isError).not.toBe(true);
    expect(executed).toHaveLength(1);
  });

  it('手動モード: 聖域言及コマンドは警告付きで承認要求される', async () => {
    await executeToolWithApproval(deps(), 'fake_exec', { command: 'echo x > CLAUDE.md' }, ctx());
    expect(requests).toHaveLength(1);
    expect(requests[0]!.warnings.some((w) => w.includes('聖域'))).toBe(true);
  });

  it('workspace がアプリリポジトリ外なら exec の言及判定はしない(誤検出防止)', async () => {
    const r = await executeToolWithApproval(
      deps({ autonomous: true, ws: otherWs }),
      'fake_exec',
      { command: 'echo x > CLAUDE.md' },
      ctx(otherWs),
    );
    expect(r.isError).not.toBe(true);
    expect(executed).toHaveLength(1);
  });
});

describe('M28-1: 判定リストの単一ソース(guardrail)', () => {
  it('sanctuary.ts は evolution/protected.ts の PROTECTED_PATHS を import している(二重定義禁止)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('./sanctuary.ts', import.meta.url)), 'utf8');
    expect(src).toContain("from '../evolution/protected'");
    expect(src).not.toMatch(/PROTECTED_PATHS\s*(?::[^=]+)?=\s*\[/); // 自前のリスト定義を持たない
  });
});
