import { describe, expect, it } from 'vitest';
import { classifyLLMError, isModelUnavailableError, isRateLimitError, shortLLMError } from './llmErrors';

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

  // M88: 上限を140→200に広げた。原因(cause: ENOTFOUND / TLS など)を後ろに足すため、
  // 140だと肝心の原因が切り落とされる(「Connection error.」だけが残って手が止まる)
  it('shortLLMError は長すぎるメッセージを切り詰める', () => {
    expect(shortLLMError(new Error('x'.repeat(300))).length).toBeLessThanOrEqual(201);
  });
});

describe('M27-1: isRateLimitError', () => {
  it('status 429・メッセージ内の429・rate limit 文言を検出する', () => {
    expect(isRateLimitError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isRateLimitError(new Error('429 {"error":...}'))).toBe(true);
    expect(isRateLimitError(new Error('Rate limit reached for model'))).toBe(true);
  });

  it('無関係なエラーや別ステータスは検出しない', () => {
    expect(isRateLimitError(Object.assign(new Error('boom'), { status: 500 }))).toBe(false);
    expect(isRateLimitError(new Error('model_not_found 404'))).toBe(false);
    expect(isRateLimitError(new Error('value is 4290'))).toBe(false);
  });
});

describe('M30-2: isModelUnavailableError / classify', () => {
  it('OpenAIのモデル未開放404(message/エラーcode両方)を検出する', () => {
    const byMessage = Object.assign(
      new Error("404 The model 'gpt-5.6-sol' does not exist or you do not have access to it"),
      { status: 404 },
    );
    expect(isModelUnavailableError(byMessage)).toBe(true);
    expect(classifyLLMError(byMessage)).toBe('model_unavailable');
    const byCode = Object.assign(new Error('404 status code (no body)'), {
      status: 404,
      error: { code: 'model_not_found', message: 'The model does not exist' },
    });
    expect(isModelUnavailableError(byCode)).toBe(true);
  });

  it('Anthropicの404 not_found(model: X)も検出する', () => {
    const err = Object.assign(new Error('404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}'), {
      status: 404,
    });
    expect(isModelUnavailableError(err)).toBe(true);
  });

  it('モデルと無関係な404や他ステータスは検出しない(transient/fatalの分類は不変)', () => {
    expect(isModelUnavailableError(Object.assign(new Error('404 page not found'), { status: 404 }))).toBe(false);
    expect(isModelUnavailableError(Object.assign(new Error('model overloaded'), { status: 503 }))).toBe(false);
    expect(classifyLLMError(Object.assign(new Error('overloaded'), { status: 503 }))).toBe('transient');
  });
});
