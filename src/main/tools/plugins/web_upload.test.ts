import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import plugin, { buildMultipartBody, isSensitiveHeader, maskHeaderForDisplay } from './web_upload';

let dir: string;

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: dir, signal: new AbortController().signal, log: () => {}, ...overrides };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'web-upload-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

describe('web_upload plugin', () => {
  it('name がファイル名と一致し、承認まわりの宣言が正しい', () => {
    expect(plugin.name).toBe('web_upload');
    expect(plugin.risk).toBe('exec');
    expect(plugin.pathParams).toContain('file');
    expect(plugin.warnings?.some((w) => w.includes('ネットワーク'))).toBe(true);
  });

  it('dynamicApproval: 常に承認必須・セッション許可なし・ヘッダ値は警告に含めない', () => {
    const policy = plugin.dynamicApproval({
      url: 'https://api.example.com/upload',
      file: 'report.pdf',
      headers: { Authorization: 'Bearer super-secret-token' },
    });
    if ('error' in policy) throw new Error('unexpected');
    expect(policy.required).toBe(true);
    expect(policy.sessionKey).toBeUndefined();
    expect(policy.auditPaths).toContain('https://api.example.com/upload');
    expect(policy.auditPaths).toContain('report.pdf');
    // 警告文にヘッダ名は出るが値は出ない
    const joined = (policy.warnings ?? []).join('\n');
    expect(joined).toContain('Authorization');
    expect(joined).not.toContain('super-secret-token');
  });

  it('dynamicApproval: 非httpスキーム・不正入力は実行前拒否', () => {
    expect(plugin.dynamicApproval({ url: 'ftp://example.com/', file: 'a.txt' })).toHaveProperty('error');
    expect(plugin.dynamicApproval(null)).toHaveProperty('error');
  });

  it('multipart アップロード成功: status/responseText/headersUsed(マスク済み)を返す', async () => {
    await writeFile(join(dir, 'report.pdf'), 'PDFDATA');
    const fetchMock = vi.fn(async () =>
      new Response('{"id":"abc123"}', { status: 201, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const r = await plugin.execute(
      {
        url: 'https://api.example.com/upload',
        file: 'report.pdf',
        method: 'POST',
        fieldName: 'file',
        headers: { Authorization: 'Bearer super-secret-token', 'X-Trace': 'trace-1' },
      },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as {
      uploaded: boolean;
      status: number;
      responseText: string;
      headersUsed: string[];
    };
    expect(parsed.uploaded).toBe(true);
    expect(parsed.status).toBe(201);
    expect(parsed.responseText).toBe('{"id":"abc123"}');
    // 秘密ヘッダはマスク・非秘密ヘッダはそのまま
    expect(parsed.headersUsed).toContain('Authorization: ***masked***');
    expect(parsed.headersUsed).toContain('X-Trace: trace-1');
    // 戻り値のどこにも秘密値が漏れない
    expect(r.content).not.toContain('super-secret-token');

    // fetch には実際の Authorization ヘッダが渡り、multipart ボディで送信される
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown[] | undefined;
    const init = call?.[1] as
      | { method?: string; headers?: Record<string, string>; body?: Uint8Array }
      | undefined;
    expect(init?.method).toBe('POST');
    expect(init?.headers?.Authorization).toBe('Bearer super-secret-token');
    expect(init?.headers?.['Content-Type']).toContain('multipart/form-data; boundary=');
    const bodyText = Buffer.from(init?.body ?? new Uint8Array()).toString('utf8');
    expect(bodyText).toContain('Content-Disposition: form-data; name="file"; filename="report.pdf"');
    expect(bodyText).toContain('PDFDATA');
  });

  it('fieldName 省略時は生ボディ(application/octet-stream)で PUT できる', async () => {
    await writeFile(join(dir, 'data.bin'), 'RAWBYTES');
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const r = await plugin.execute(
      { url: 'https://api.example.com/put', file: 'data.bin', method: 'PUT' },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content) as { uploaded: boolean; status: number };
    expect(parsed.uploaded).toBe(true);
    expect(parsed.status).toBe(200);

    const call = fetchMock.mock.calls[0] as unknown[] | undefined;
    const init = call?.[1] as
      | { method?: string; headers?: Record<string, string>; body?: Uint8Array }
      | undefined;
    expect(init?.method).toBe('PUT');
    expect(init?.headers?.['Content-Type']).toBe('application/octet-stream');
    expect(Buffer.from(init?.body ?? new Uint8Array()).toString('utf8')).toBe('RAWBYTES');
  });

  it('ワークスペース外のファイルパスは拒否(fetchしない)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const abs = await plugin.execute(
      { url: 'https://api.example.com/upload', file: join(tmpdir(), 'evil.txt') },
      ctx(),
    );
    expect(abs.isError).toBe(true);
    expect((JSON.parse(abs.content) as { uploaded: boolean; error: string })).toEqual({
      uploaded: false,
      error: 'file path outside workspace is not allowed',
    });

    const escape = await plugin.execute(
      { url: 'https://api.example.com/upload', file: '../escape.txt' },
      ctx(),
    );
    expect(escape.isError).toBe(true);
    expect((JSON.parse(escape.content) as { error: string }).error).toBe(
      'file path outside workspace is not allowed',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('存在しないファイルはエラー', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const r = await plugin.execute({ url: 'https://api.example.com/upload', file: 'nope.txt' }, ctx());
    expect(r.isError).toBe(true);
    expect((JSON.parse(r.content) as { uploaded: boolean }).uploaded).toBe(false);
  });

  it('HTTPエラーステータスは uploaded:false でステータスとボディを返す', async () => {
    await writeFile(join(dir, 'f.txt'), 'x');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('denied', { status: 403 })));
    const r = await plugin.execute(
      { url: 'https://api.example.com/upload', file: 'f.txt', fieldName: 'file' },
      ctx(),
    );
    const parsed = JSON.parse(r.content) as { uploaded: boolean; status: number; responseText: string };
    expect(parsed.uploaded).toBe(false);
    expect(parsed.status).toBe(403);
    expect(parsed.responseText).toBe('denied');
  });

  it('長いレスポンスボディは切り詰める', async () => {
    await writeFile(join(dir, 'f.txt'), 'x');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a'.repeat(10_000), { status: 200 })));
    const r = await plugin.execute({ url: 'https://api.example.com/upload', file: 'f.txt' }, ctx());
    const parsed = JSON.parse(r.content) as { responseText: string; responseTruncated?: boolean };
    expect(parsed.responseText.length).toBe(2_000);
    expect(parsed.responseTruncated).toBe(true);
  });

  it('ネットワークエラーはエラーとして返す(秘密値は含まない)', async () => {
    await writeFile(join(dir, 'f.txt'), 'x');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }),
    );
    const r = await plugin.execute(
      { url: 'https://api.example.com/upload', file: 'f.txt', headers: { Authorization: 'Bearer sec' } },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('アップロード失敗');
    expect(r.content).not.toContain('Bearer sec');
  });

  it('不正な入力はエラー', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect((await plugin.execute(null, ctx())).isError).toBe(true);
    expect((await plugin.execute({ url: '', file: 'a' }, ctx())).isError).toBe(true);
    expect((await plugin.execute({ url: 'https://x.example/', file: '' }, ctx())).isError).toBe(true);
    expect(
      (await plugin.execute({ url: 'https://x.example/', file: 'a.txt', method: 'DELETE' }, ctx())).isError,
    ).toBe(true);
    expect(
      (await plugin.execute({ url: 'https://x.example/', file: 'a.txt', headers: { 'Bad Name!': 'v' } }, ctx()))
        .isError,
    ).toBe(true);
    expect(
      (await plugin.execute({ url: 'ftp://x.example/', file: 'a.txt' }, ctx())).isError,
    ).toBe(true);
  });
});

describe('isSensitiveHeader / maskHeaderForDisplay', () => {
  it('秘密情報ヘッダを判別する', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('cookie')).toBe(true);
    expect(isSensitiveHeader('X-Api-Key')).toBe(true);
    expect(isSensitiveHeader('X-Auth-Token')).toBe(true);
    expect(isSensitiveHeader('Content-Type')).toBe(false);
    expect(isSensitiveHeader('X-Trace')).toBe(false);
  });

  it('秘密ヘッダのみ値をマスクする', () => {
    expect(maskHeaderForDisplay('Authorization', 'Bearer xxx')).toBe('Authorization: ***masked***');
    expect(maskHeaderForDisplay('X-Trace', 'abc')).toBe('X-Trace: abc');
  });
});

describe('buildMultipartBody', () => {
  it('boundary 付き multipart ボディを組み立てる', () => {
    const { body, contentType } = buildMultipartBody('file', 'a.txt', Buffer.from('DATA'));
    const m = /boundary=(.+)$/.exec(contentType);
    expect(m).not.toBeNull();
    const boundary = m?.[1] ?? '';
    const text = body.toString('utf8');
    expect(text.startsWith(`--${boundary}\r\n`)).toBe(true);
    expect(text).toContain('Content-Disposition: form-data; name="file"; filename="a.txt"');
    expect(text).toContain('DATA');
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
  });

  it('ファイル名の引用符・改行は無害化する', () => {
    const { body } = buildMultipartBody('f', 'ev"il\r\n.txt', Buffer.from('x'));
    const text = body.toString('utf8');
    expect(text).toContain('filename="ev_il__.txt"');
  });
});
