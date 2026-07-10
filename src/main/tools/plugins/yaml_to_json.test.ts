import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import plugin from './yaml_to_json';
import type { ToolContext } from '../types';

function createTestContext(cwd = process.cwd()): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    log: () => {},
  };
}

describe('yaml_to_json plugin', () => {
  it('has correct name and metadata', () => {
    expect(plugin.name).toBe('yaml_to_json');
    expect(plugin.risk).toBe('safe');
    expect(plugin.tags).toContain('テキスト処理');
    expect(plugin.pathParams).toContain('path');
  });

  it('converts simple mapping with sequence (pretty by default)', async () => {
    const result = await plugin.execute(
      { yaml: 'name: demo\nitems:\n  - 1\n  - 2' },
      createTestContext(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      '{\n  "name": "demo",\n  "items": [\n    1,\n    2\n  ]\n}',
    );
  });

  it('outputs compact JSON when pretty=false', async () => {
    const result = await plugin.execute(
      { yaml: 'name: demo\nitems:\n  - 1\n  - 2', pretty: false },
      createTestContext(),
    );
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('{"name":"demo","items":[1,2]}');
  });

  it('respects custom indent width', async () => {
    const result = await plugin.execute({ yaml: 'a: 1', indent: 4 }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('{\n    "a": 1\n}');
  });

  it('coerces scalars: null / bool / int / float / string', async () => {
    const yaml = [
      'nothing: null',
      'tilde: ~',
      'empty:',
      'yes_flag: true',
      'no_flag: false',
      'int: 42',
      'neg: -7',
      'float: 3.14',
      'exp: 1e3',
      'hex: 0x1F',
      'text: hello world',
      'version_like: "1.0"',
    ].join('\n');
    const result = await plugin.execute({ yaml, pretty: false }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({
      nothing: null,
      tilde: null,
      empty: null,
      yes_flag: true,
      no_flag: false,
      int: 42,
      neg: -7,
      float: 3.14,
      exp: 1000,
      hex: 31,
      text: 'hello world',
      version_like: '1.0',
    });
  });

  it('parses nested mappings and sequences of mappings', async () => {
    const yaml = [
      'server:',
      '  host: localhost',
      '  ports:',
      '    - 80',
      '    - 443',
      'users:',
      '  - name: alice',
      '    admin: true',
      '  - name: bob',
      '    admin: false',
    ].join('\n');
    const result = await plugin.execute({ yaml, pretty: false }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({
      server: { host: 'localhost', ports: [80, 443] },
      users: [
        { name: 'alice', admin: true },
        { name: 'bob', admin: false },
      ],
    });
  });

  it('parses flow collections and quoted strings', async () => {
    const yaml = [
      'arr: [1, two, "three, four"]',
      "obj: {a: 1, b: 'x y'}",
      'quoted: "line1\\nline2"',
      "single: 'it''s'",
    ].join('\n');
    const result = await plugin.execute({ yaml, pretty: false }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({
      arr: [1, 'two', 'three, four'],
      obj: { a: 1, b: 'x y' },
      quoted: 'line1\nline2',
      single: "it's",
    });
  });

  it('parses block scalars (literal and folded)', async () => {
    const yaml = [
      'lit: |',
      '  line1',
      '  line2',
      'fold: >',
      '  word1',
      '  word2',
      'stripped: |-',
      '  no trailing',
    ].join('\n');
    const result = await plugin.execute({ yaml, pretty: false }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({
      lit: 'line1\nline2\n',
      fold: 'word1 word2\n',
      stripped: 'no trailing',
    });
  });

  it('ignores comments and blank lines', async () => {
    const yaml = ['# top comment', 'a: 1 # trailing', '', 'b: "#not a comment"'].join('\n');
    const result = await plugin.execute({ yaml, pretty: false }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ a: 1, b: '#not a comment' });
  });

  it('returns array for multi-document YAML', async () => {
    const yaml = ['---', 'a: 1', '---', '- x', '- y', '---', 'plain'].join('\n');
    const result = await plugin.execute({ yaml, pretty: false }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual([{ a: 1 }, ['x', 'y'], 'plain']);
  });

  it('single document with leading --- is not wrapped in an array', async () => {
    const result = await plugin.execute({ yaml: '---\na: 1', pretty: false }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ a: 1 });
  });

  it('reports parse error with line number for unclosed flow', async () => {
    const result = await plugin.execute({ yaml: 'a: [1, 2' }, createTestContext());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/^YAML parse error at line 1: /);
  });

  it('reports parse error with line number for bad indentation line', async () => {
    const yaml = 'a: 1\n\tb: 2';
    const result = await plugin.execute({ yaml }, createTestContext());
    expect(result.isError).toBe(true);
    expect(result.content).toContain('line 2');
  });

  it('rejects anchors/aliases as unsupported with line number', async () => {
    const result = await plugin.execute({ yaml: 'a: &anchor 1\nb: *anchor' }, createTestContext());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/YAML parse error at line 1/);
  });

  it('errors when both yaml and path are given, or neither', async () => {
    const both = await plugin.execute({ yaml: 'a: 1', path: 'x.yaml' }, createTestContext());
    expect(both.isError).toBe(true);
    const neither = await plugin.execute({}, createTestContext());
    expect(neither.isError).toBe(true);
    expect(neither.content).toContain('どちらか一方');
  });

  it('validates pretty and indent options', async () => {
    const badPretty = await plugin.execute({ yaml: 'a: 1', pretty: 'yes' }, createTestContext());
    expect(badPretty.isError).toBe(true);
    const badIndent = await plugin.execute({ yaml: 'a: 1', indent: 99 }, createTestContext());
    expect(badIndent.isError).toBe(true);
  });

  it('handles empty yaml text as null', async () => {
    const result = await plugin.execute({ yaml: '' }, createTestContext());
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('null');
  });

  describe('path input', () => {
    let dir = '';

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'yaml-to-json-'));
      await writeFile(join(dir, 'config.yaml'), 'name: demo\nitems:\n  - 1\n  - 2\n', 'utf8');
    });

    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('reads YAML file relative to cwd', async () => {
      const result = await plugin.execute(
        { path: 'config.yaml', pretty: false },
        createTestContext(dir),
      );
      expect(result.isError).toBeUndefined();
      expect(result.content).toBe('{"name":"demo","items":[1,2]}');
    });

    it('errors for missing file', async () => {
      const result = await plugin.execute({ path: 'nope.yaml' }, createTestContext(dir));
      expect(result.isError).toBe(true);
      expect(result.content).toContain('ファイルが存在しない');
    });
  });
});
