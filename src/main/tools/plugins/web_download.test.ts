import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { resolveWorkspacePath } from './web_download';

let dir: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, log: () => {}, ...overrides };
}

function binaryResponse(
  data: Uint8Array | string,
  init: { status?: number; contentType?: string; contentLength?: string } = {},
): Response {
  const headers: Record<string, string> = { 'content-type': init.contentType ?? 'text/csv' };
  if (init.contentLength !== undefined) headers['content-length'] = init.contentLength;
  return new Response(data, { status: init.status ?? 200, headers });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'web-download-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('web_download plugin', () => {
  it('name がファイル名と一致し、承認まわりの宣言が正しい', () => {
    expect(plugin.name).toBe('web_download');
    expect(plugin.risk).toBe('write');
    expect(plugin.pathParams).toContain('dest');
    expect(plugin.warnings?.some((w) => w.includes('ネットワーク'))).toBe(true);
  });

  it('dynamicApproval: 常に承認必須・セッション許可なし・audit対象あり', () => {
    const policy = plugin.dynamicApproval({ url: 'https://example.com/f.csv', dest: 'downloads/f.csv' });
    expect(policy).not.toHaveProperty('error');
    if ('error' in policy) throw new Error('unexpected');
    expect(policy.required).toBe(true);
    expect(policy.sessionKey).toBeUndefined();
    expect(policy.auditPaths).toContain('https://example.com/f.csv');
    expect(policy.auditPaths).toContain('downloads/f.csv');
  });

  it('dynamicApproval: 非httpスキーム・不正入力は実行前拒否', () => {
    expect(plugin.dynamicApproval({ url: 'file:///etc/passwd', dest: 'a.txt' })).toHaveProperty('error');
    expect(plugin.dynamicApproval(null)).toHaveProperty('error');
  });

  it('ダウンロード成功: path/bytes/sha256/contentType を返す', async () => {
    const data = Buffer.from('col1,col2\n1,2\n', 'utf8');
    vi.stubGlobal('fetch', vi.fn(async () => binaryResponse(new Uint8Array(data))));

    const r = await plugin.execute({ url: 'https://example.com/sample.csv', dest: 'downloads/sample.csv' }, ctx());
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as {
      downloaded: boolean;
      path: string;
      bytes: number;
      sha256: string;
      contentType: string;
    };
    expect(parsed.downloaded).toBe(true);
    expect(parsed.path).toBe('downloads/sample.csv');
    expect(parsed.bytes).toBe(data.length);
    expect(parsed.sha256).toBe(createHash('sha256').update(data).digest('hex'));
    expect(parsed.contentType).toBe('text/csv');

    const saved = await readFile(join(dir, 'downloads/sample.csv'));
    expect(saved.equals(data)).toBe(true);
    // 一時ファイル(.part)は残らない
    const entries = await readdir(join(dir, 'downloads'));
    expect(entries).toEqual(['sample.csv']);
  });

  it('既存ファイルは overwrite なしだと上書きしない(fetchもしない)', async () => {
    await writeFile(join(dir, 'exists.txt'), 'old');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const r = await plugin.execute({ url: 'https://example.com/x', dest: 'exists.txt' }, ctx());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content) as { downloaded: boolean; error: string };
    expect(parsed.downloaded).toBe(false);
    expect(parsed.error).toBe('destination exists; pass overwrite:true');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(join(dir, 'exists.txt'), 'utf8')).toBe('old');
  });

  it('overwrite:true なら既存ファイルを上書きする', async () => {
    await writeFile(join(dir, 'exists.txt'), 'old');
    vi.stubGlobal('fetch', vi.fn(async () => binaryResponse('new content')));

    const r = await plugin.execute(
      { url: 'https://example.com/x', dest: 'exists.txt', overwrite: true },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(await readFile(join(dir, 'exists.txt'), 'utf8')).toBe('new content');
  });

  it('Content-Length がサイズ上限超過なら本文を読まず中断', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        binaryResponse(new Uint8Array([1]), { contentLength: String(200 * 1024 * 1024) }),
      ),
    );
    const r = await plugin.execute({ url: 'https://example.com/big.bin', dest: 'big.bin' }, ctx());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content) as { downloaded: boolean; error: string };
    expect(parsed.downloaded).toBe(false);
    expect(parsed.error).toBe('size limit exceeded (100MB)');
  });

  it('絶対パス・「..」脱出の dest は拒否(fetchしない)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const abs = await plugin.execute({ url: 'https://example.com/x', dest: join(tmpdir(), 'evil.txt') }, ctx());
    expect(abs.isError).toBe(true);
    expect(JSON.parse(abs.content)).toMatchObject({ downloaded: false });

    const escape = await plugin.execute({ url: 'https://example.com/x', dest: '../escape.txt' }, ctx());
    expect(escape.isError).toBe(true);
    expect((JSON.parse(escape.content) as { error: string }).error).toContain('outside workspace');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writeAllowlist 外の dest は拒否', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await plugin.execute(
      { url: 'https://example.com/x', dest: 'outside/a.txt' },
      ctx({ writeAllowlist: ['allowed'] }),
    );
    expect(r.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('http/https 以外のスキームは拒否', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const r = await plugin.execute({ url: 'file:///etc/passwd', dest: 'a.txt' }, ctx());
    expect(r.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HTTPエラーステータスはファイルを作らずエラー', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => binaryResponse('not found', { status: 404 })));
    const r = await plugin.execute({ url: 'https://example.com/missing', dest: 'missing.txt' }, ctx());
    expect(r.isError).toBe(true);
    expect((JSON.parse(r.content) as { error: string }).error).toContain('404');
    const entries = await readdir(dir);
    expect(entries).toEqual([]);
  });

  it('ネットワークエラーはエラーとして返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );
    const r = await plugin.execute({ url: 'https://no-such-host.invalid/f', dest: 'f.bin' }, ctx());
    expect(r.isError).toBe(true);
    expect((JSON.parse(r.content) as { error: string }).error).toContain('取得失敗');
  });

  it('不正な入力はエラー', async () => {
    expect((await plugin.execute(null, ctx())).isError).toBe(true);
    expect((await plugin.execute({ url: '', dest: 'a' }, ctx())).isError).toBe(true);
    expect((await plugin.execute({ url: 'https://example.com/', dest: '' }, ctx())).isError).toBe(true);
    expect((await plugin.execute({ url: 'not a url %%%', dest: 'a.txt' }, ctx())).isError).toBe(true);
  });
});

describe('resolveWorkspacePath', () => {
  it('ワークスペース内の相対パスを解決する', () => {
    const base = join(tmpdir(), 'ws');
    const r = resolveWorkspacePath(base, 'sub/file.txt');
    expect(r).not.toHaveProperty('error');
    if ('error' in r) throw new Error('unexpected');
    expect(r.rel).toBe('sub/file.txt');
  });

  it('絶対パス・脱出パスは拒否', () => {
    const base = join(tmpdir(), 'ws');
    expect(resolveWorkspacePath(base, join(tmpdir(), 'other', 'f.txt'))).toHaveProperty('error');
    expect(resolveWorkspacePath(base, '../escape.txt')).toHaveProperty('error');
    expect(resolveWorkspacePath(base, 'a/../../escape.txt')).toHaveProperty('error');
  });
});
