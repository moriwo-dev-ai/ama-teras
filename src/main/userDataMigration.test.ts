import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasRealData, migrateUserData } from './userDataMigration';

describe('userDataMigration (M17-1)', () => {
  let base: string;
  let oldDir: string;
  let newDir: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'amateras-migrate-'));
    oldDir = join(base, 'mycodex');
    newDir = join(base, 'amateras');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function seedOld(): Promise<void> {
    await mkdir(join(oldDir, 'sessions', 'blobs'), { recursive: true });
    await writeFile(join(oldDir, 'config.json'), '{"provider":"openai"}', 'utf8');
    await writeFile(join(oldDir, 'secrets.json'), '{"openai":"encrypted"}', 'utf8');
    await writeFile(join(oldDir, 'sessions', 'abc.json'), '{"id":"abc"}', 'utf8');
    await writeFile(join(oldDir, 'sessions', 'blobs', 'x.bin'), 'img', 'utf8');
    await writeFile(join(oldDir, 'audit.jsonl'), '{"ts":"t"}\n', 'utf8');
  }

  it('旧に実データあり・新なし → キー・履歴が新へ移行される(旧は残る)', async () => {
    await seedOld();
    // electron が先にキャッシュ用ディレクトリを作っていても移行される(存在判定でなく実データ判定)
    await mkdir(join(newDir, 'Cache'), { recursive: true });

    const r = migrateUserData(oldDir, newDir);
    expect(r).toMatchObject({ migrated: true, reason: 'done' });
    expect(await readFile(join(newDir, 'config.json'), 'utf8')).toContain('openai');
    expect(await readFile(join(newDir, 'secrets.json'), 'utf8')).toContain('encrypted');
    expect(await readFile(join(newDir, 'sessions', 'abc.json'), 'utf8')).toContain('abc');
    expect(existsSync(join(newDir, 'sessions', 'blobs', 'x.bin'))).toBe(true);
    // 旧はロールバック用に無傷
    expect(existsSync(join(oldDir, 'secrets.json'))).toBe(true);
  });

  it('新のみ実データあり → 何もしない', async () => {
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, 'config.json'), '{"provider":"anthropic"}', 'utf8');

    const r = migrateUserData(oldDir, newDir);
    expect(r).toMatchObject({ migrated: false, reason: 'new-has-data' });
    expect(await readFile(join(newDir, 'config.json'), 'utf8')).toContain('anthropic');
  });

  it('両方に実データあり → 新を優先し何もしない', async () => {
    await seedOld();
    await mkdir(newDir, { recursive: true });
    await writeFile(join(newDir, 'config.json'), '{"provider":"anthropic"}', 'utf8');

    const r = migrateUserData(oldDir, newDir);
    expect(r).toMatchObject({ migrated: false, reason: 'new-has-data' });
    expect(await readFile(join(newDir, 'config.json'), 'utf8')).toContain('anthropic');
    expect(existsSync(join(newDir, 'secrets.json'))).toBe(false);
  });

  it('旧なし → 何もしない(新規ユーザー)', () => {
    const r = migrateUserData(oldDir, newDir);
    expect(r).toMatchObject({ migrated: false, reason: 'no-old-data' });
  });

  it('マーカーがあれば再実行しない(冪等)', async () => {
    await seedOld();
    expect(migrateUserData(oldDir, newDir).migrated).toBe(true);
    // 移行後に新側でデータを消しても、マーカーがある限り再コピーしない
    await rm(join(newDir, 'config.json'));
    const r = migrateUserData(oldDir, newDir);
    expect(r).toMatchObject({ migrated: false, reason: 'already-migrated' });
    expect(existsSync(join(newDir, 'config.json'))).toBe(false);
  });

  it('hasRealData はキャッシュ類だけのディレクトリを実データとみなさない', async () => {
    await mkdir(join(newDir, 'Cache'), { recursive: true });
    await mkdir(join(newDir, 'GPUCache'), { recursive: true });
    expect(hasRealData(newDir)).toBe(false);
  });
});
