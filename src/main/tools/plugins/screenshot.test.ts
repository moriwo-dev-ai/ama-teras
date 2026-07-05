import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import screenshot, { isLocalHost } from './screenshot';

function ctx(overrides?: Partial<ToolContext>): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal, log: () => {}, ...overrides };
}

describe('screenshot プラグイン(M14-2)', () => {
  it('isLocalHost: localhost/127.0.0.1/IPv6ループバックのみ true', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('LOCALHOST')).toBe(true);
    expect(isLocalHost('example.com')).toBe(false);
    expect(isLocalHost('localhost.evil.com')).toBe(false);
    expect(isLocalHost('192.168.1.10')).toBe(false); // LAN内も外部扱い(承認制)
  });

  it('dynamicApproval: localhost は承認不要、外部はドメイン単位キー+audit対象', () => {
    const local = screenshot.dynamicApproval!({ url: 'http://localhost:5173/app' });
    expect(local).toEqual({ required: false });

    const ext = screenshot.dynamicApproval!({ url: 'https://Example.COM/path?q=1' });
    expect(ext).toMatchObject({
      required: true,
      sessionKey: 'screenshot@example.com',
      sessionLabel: 'example.com',
      auditPaths: ['https://example.com/path?q=1'],
    });
  });

  it('dynamicApproval: 非http/httpsスキーム・不正URLは error(実行前拒否)', () => {
    for (const url of ['file:///etc/passwd', 'chrome://gpu', 'ftp://x', 'not a url', '']) {
      const r = screenshot.dynamicApproval!({ url });
      expect('error' in r, url).toBe(true);
    }
  });

  it('execute: capture結果を画像付き tool_result で返し、viewport はクランプされる', async () => {
    const capture = vi.fn(async () => ({ data: 'aW1n', mediaType: 'image/png' }));
    const r = await screenshot.execute(
      { url: 'http://localhost:3000/', width: 99999, height: 100 },
      ctx({ screenshot: { capture } }),
    );
    expect(r.isError).not.toBe(true);
    expect(r.images).toEqual([
      { mediaType: 'image/png', data: 'aW1n', description: 'screenshot: http://localhost:3000/' },
    ]);
    expect(capture).toHaveBeenCalledWith('http://localhost:3000/', 4096, 240); // クランプ
  });

  it('execute: 未注入コンテキストと capture 失敗はエラー', async () => {
    const none = await screenshot.execute({ url: 'http://localhost:3000/' }, ctx());
    expect(none.isError).toBe(true);

    const failing = vi.fn(async () => {
      throw new Error('読み込みタイムアウト');
    });
    const r = await screenshot.execute({ url: 'http://localhost:3000/' }, ctx({ screenshot: { capture: failing } }));
    expect(r.isError).toBe(true);
    expect(r.content).toContain('タイムアウト');
  });
});
