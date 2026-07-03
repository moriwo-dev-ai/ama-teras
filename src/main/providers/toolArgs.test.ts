import { describe, expect, it } from 'vitest';
import { parseToolArguments } from './toolArgs';

describe('parseToolArguments(指摘#7)', () => {
  it('正常なJSONを解析する', () => {
    expect(parseToolArguments('{"path":"a.txt"}')).toEqual({ input: { path: 'a.txt' } });
  });

  it('空文字は {} を返しエラーなし', () => {
    expect(parseToolArguments('')).toEqual({ input: {} });
    expect(parseToolArguments('   ')).toEqual({ input: {} });
  });

  it('壊れたJSON(途中切れ)は error を返し握りつぶさない', () => {
    const r = parseToolArguments('{"path":"a.txt","content":"unterminated');
    expect(r.input).toEqual({});
    expect(r.error).toMatch(/解析に失敗/);
    expect(r.error).toContain('unterminated'); // 生データを含めモデルが原因を掴める
  });
});
