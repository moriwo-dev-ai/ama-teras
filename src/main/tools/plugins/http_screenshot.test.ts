import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext, ToolResult } from '../types';
import plugin from './http_screenshot';

function createBaseCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    log: () => {
      // noop for tests
    },
  };
}

describe('http_screenshot plugin', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = createBaseCtx();
  });

  it('returns error JSON when input is invalid', async () => {
    const res = (await plugin.execute(null, ctx)) as ToolResult;
    const parsed = JSON.parse(res.content) as { ok: boolean; status: number; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(0);
    expect(parsed.error).toContain('input はオブジェクト');
  });

  it('returns error JSON when ctx.screenshot is missing', async () => {
    const res = await plugin.execute({ url: 'http://127.0.0.1:8123' }, ctx);
    const parsed = JSON.parse(res.content) as { ok: boolean; status: number; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(0);
    expect(parsed.error).toContain('screenshot 未注入');
  });

  it('writes screenshot to temp file and returns path with status 200', async () => {
    const capture = vi.fn().mockResolvedValue({ data: Buffer.from('testdata').toString('base64'), mediaType: 'image/png' });

    ctx.screenshot = {
      capture,
    };

    const res = await plugin.execute({ url: 'http://127.0.0.1:8123', width: 390, height: 844 }, ctx);
    const parsed = JSON.parse(res.content) as { ok: boolean; status: number; screenshotPath?: string; error?: string };

    expect(parsed.ok).toBe(true);
    expect(parsed.status).toBe(200);
    expect(typeof parsed.screenshotPath).toBe('string');
    expect(parsed.screenshotPath && parsed.screenshotPath.length).toBeGreaterThan(0);
  });

  it('returns error JSON when URL is invalid', async () => {
    ctx.screenshot = {
      capture: vi.fn(),
    };
    const res = await plugin.execute({ url: '::not-a-url::' }, ctx);
    const parsed = JSON.parse(res.content) as { ok: boolean; status: number; error?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(0);
    expect(parsed.error && parsed.error.length).toBeGreaterThan(0);
  });
});
