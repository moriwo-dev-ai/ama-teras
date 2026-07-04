import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from './audit';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mycodex-audit-'));
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
});
