import { describe, expect, it } from 'vitest';
import { classifyLLMError, shortLLMError } from './llmErrors';

describe('classifyLLMError(M16-2)', () => {
  it('課金系はステータスに関わらず billing(429より優先)', () => {
    // Anthropic: 残高枯渇は400で来る(AICAD一晩テストの実物)
    expect(
      classifyLLMError(
        new Error(
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
        ),
      ),
    ).toBe('billing');
    // OpenAI: insufficient_quota は 429 で来るが billing
    const quota = Object.assign(new Error('429 insufficient_quota: You exceeded your current quota'), {
      status: 429,
    });
    expect(classifyLLMError(quota)).toBe('billing');
    expect(classifyLLMError(Object.assign(new Error('Payment Required'), { status: 402 }))).toBe('billing');
  });

  it('レート制限・5xx・ネットワークは transient', () => {
    expect(classifyLLMError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe('transient');
    expect(classifyLLMError(Object.assign(new Error('Overloaded'), { status: 529 }))).toBe('transient');
    expect(classifyLLMError(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe('transient');
    expect(classifyLLMError(new Error('503 Service Unavailable'))).toBe('transient');
    expect(classifyLLMError(new Error('fetch failed'))).toBe('transient');
    expect(classifyLLMError(new Error('read ECONNRESET'))).toBe('transient');
    expect(classifyLLMError(new Error('Request timed out'))).toBe('transient');
  });

  it('不正リクエスト等は fatal', () => {
    expect(classifyLLMError(Object.assign(new Error('invalid_request_error: max_tokens'), { status: 400 }))).toBe('fatal');
    expect(classifyLLMError(new Error('モデル応答が空だった'))).toBe('fatal');
  });

  it('shortLLMError は140文字に切り詰める', () => {
    expect(shortLLMError(new Error('x'.repeat(300))).length).toBeLessThanOrEqual(141);
  });
});
