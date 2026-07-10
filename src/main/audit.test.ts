import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from './audit';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'amateras-audit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('AuditLog', () => {
  it('JSONL 形式で追記され、ts が付与される', async () => {
    const log = new AuditLog(join(dir, 'sub', 'audit.jsonl'));
    log.append({ tool: 'write_file', scope: 'system', paths: ['C:/x/a.txt'], event: 'approval', detail: 'allow' });
    log.append({ tool: 'write_file', scope: 'system', paths: ['C:/x/a.txt'], event: 'result', detail: 'ok' });

    const raw = await readFile(join(dir, 'sub', 'audit.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first: unknown = JSON.parse(lines[0]!);
    const rec = first as Record<string, unknown>;
    expect(rec['tool']).toBe('write_file');
    expect(rec['event']).toBe('approval');
    expect(rec['detail']).toBe('allow');
    expect(typeof rec['ts']).toBe('string');
    expect(Number.isNaN(Date.parse(rec['ts'] as string))).toBe(false);
  });

  it('書き込み不能でも例外を投げない(ベストエフォート)', () => {
    // ディレクトリをファイルパスとして渡す → appendFileSync が失敗するが握りつぶす
    const log = new AuditLog(dir);
    expect(() =>
      log.append({ tool: 'bash', scope: 'system', paths: [], event: 'hard-deny', detail: 'x' }),
    ).not.toThrow();
  });

  // ---- M10: tail(スマホUIの閲覧用) ----

  it('tail は末尾 limit 件を新しい順で返す', () => {
    const log = new AuditLog(join(dir, 'audit.jsonl'));
    for (let i = 1; i <= 5; i++) {
      log.append({ tool: `tool-${i}`, scope: 'system', paths: [], event: 'result', detail: 'ok' });
    }
    const tail = log.tail(2);
    expect(tail.map((e) => e.tool)).toEqual(['tool-5', 'tool-4']);
    expect(typeof tail[0]?.ts).toBe('string');
  });

  it('tail はファイル無し・壊れた行でも例外を出さない', async () => {
    expect(new AuditLog(join(dir, 'missing.jsonl')).tail(10)).toEqual([]);
    const log = new AuditLog(join(dir, 'mixed.jsonl'));
    log.append({ tool: 'ok-tool', scope: 'system', paths: [], event: 'result', detail: 'ok' });
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(dir, 'mixed.jsonl'), 'not-json\n{"noTs":true}\n', 'utf8');
    expect(log.tail(10).map((e) => e.tool)).toEqual(['ok-tool']);
  });
});
