import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  downloadRegistryPlugin,
  fetchRegistryIndex,
  matchRegistryEntries,
  type RegistryIndexEntry,
} from './search';

function fakeFetch(routes: Record<string, unknown | Buffer>, ok = true): typeof fetch {
  return (async (url: unknown) => {
    const body = routes[String(url)];
    if (body === undefined) return { ok: false, status: 404 };
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body))),
    };
  }) as unknown as typeof fetch;
}

const ENTRY: RegistryIndexEntry = {
  name: 'text_stats',
  description: 'テキストの文字数・行数・単語数を数える',
  version: '1.0.0',
  author: 'someone',
  verified: true,
  path: 'plugins/text_stats',
  files: ['text_stats.ts', 'manifest.json'],
};

describe('M28-3: fetchRegistryIndex', () => {
  it('index.json をパースし、不正エントリ(パス区切り入りファイル名等)は落とす', async () => {
    const idx = await fetchRegistryIndex(
      'https://reg.example/',
      fakeFetch({
        'https://reg.example/index.json': {
          registryVersion: 1,
          plugins: [
            ENTRY,
            { ...ENTRY, name: 'evil', files: ['../../../etc/passwd'] }, // トラバーサル
            { ...ENTRY, name: 'bad name!' }, // ツール名規則違反
            { ...ENTRY, name: 'no_files', files: [] },
          ],
        },
      }),
    );
    expect(idx).toHaveLength(1);
    expect(idx?.[0]?.name).toBe('text_stats');
  });

  it('不達・HTTPエラー・不正JSONは null(静かにフォールバック)', async () => {
    const err = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await fetchRegistryIndex('https://reg.example', err)).toBeNull();
    expect(await fetchRegistryIndex('https://reg.example', fakeFetch({}, true))).toBeNull(); // 404
    expect(
      await fetchRegistryIndex('https://reg.example', fakeFetch({ 'https://reg.example/index.json': { nope: 1 } })),
    ).toBeNull();
  });
});

describe('M28-3: matchRegistryEntries', () => {
  const entries: RegistryIndexEntry[] = [
    ENTRY,
    { ...ENTRY, name: 'csv_to_markdown', description: 'CSVをMarkdownの表に変換する' },
  ];

  it('依頼文のトークン重なりでスコアリングし降順で返す', () => {
    const m = matchRegistryEntries(entries, 'CSVファイルをMarkdownに変換したい');
    expect(m[0]?.entry.name).toBe('csv_to_markdown');
  });

  it('ツール名の直接言及は強くマッチする', () => {
    const m = matchRegistryEntries(entries, 'text_stats 的なものが欲しい');
    expect(m[0]?.entry.name).toBe('text_stats');
  });

  it('無関係な依頼はマッチしない(空配列)', () => {
    expect(matchRegistryEntries(entries, 'zzz qqq vvv')).toHaveLength(0);
  });
});

describe('M28-3: downloadRegistryPlugin', () => {
  let dest: string;
  beforeEach(async () => {
    dest = join(await mkdtemp(join(tmpdir(), 'amateras-regdl-')), 'text_stats');
  });
  afterEach(async () => {
    await rm(join(dest, '..'), { recursive: true, force: true }).catch(() => {});
  });

  it('全ファイルを destDir へ書き出す', async () => {
    const r = await downloadRegistryPlugin(
      'https://reg.example',
      ENTRY,
      dest,
      fakeFetch({
        'https://reg.example/plugins/text_stats/text_stats.ts': Buffer.from('export default {};'),
        'https://reg.example/plugins/text_stats/manifest.json': Buffer.from('{}'),
      }),
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(dest, 'text_stats.ts'))).toBe(true);
    expect(await readFile(join(dest, 'manifest.json'), 'utf8')).toBe('{}');
  });

  it('1ファイルでも失敗したら ok:false', async () => {
    const r = await downloadRegistryPlugin(
      'https://reg.example',
      ENTRY,
      dest,
      fakeFetch({
        'https://reg.example/plugins/text_stats/text_stats.ts': Buffer.from('x'),
        // manifest.json は 404
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.message).toContain('404');
  });
});
