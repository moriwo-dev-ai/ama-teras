import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * yaml_to_json: YAMLテキスト/YAMLファイルをJSON文字列へ変換する。
 * 外部依存なし(依存追加禁止のため)で、実用的なYAMLサブセットを自前パースする:
 * - ブロックマッピング / ブロックシーケンス(インデントベース)
 * - フローコレクション [..] {..}(複数行にまたがってもよい)
 * - 引用符付き文字列(" ' とエスケープ)、プレーンスカラー(null/bool/数値の型変換)
 * - ブロックスカラー(| リテラル / > 折りたたみ、チョンピング指示子 + -)
 * - コメント(#)、複数ドキュメント(--- 区切り → JSON配列)
 * 未対応: アンカー/エイリアス(&, *)、タグ(!!)、複雑キー(?)。
 */

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 500_000;

type YamlValue = null | boolean | number | string | YamlValue[] | { [key: string]: YamlValue };

class YamlError extends Error {
  readonly line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

interface SrcLine {
  /** インデント除去前の元の行(ブロックスカラー用) */
  raw: string;
  indent: number;
  /** インデントを除いた本文 */
  content: string;
  lineNo: number;
  blank: boolean;
}

function toLines(text: string): SrcLine[] {
  const out: SrcLine[] = [];
  const rows = text.split(/\r\n|\r|\n/);
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i] ?? '';
    let indent = 0;
    while (indent < raw.length && raw.charAt(indent) === ' ') indent++;
    if (raw.charAt(indent) === '\t') {
      throw new YamlError(i + 1, 'インデントにタブは使えない(YAMLはスペースのみ)');
    }
    const content = raw.slice(indent);
    out.push({ raw, indent, content, lineNo: i + 1, blank: content.trim() === '' });
  }
  return out;
}

/** 引用符の外にある " #"(または行頭の #)以降のコメントを除去する */
function stripComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (inDouble) {
      if (c === '\\') i++;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") {
        if (s.charAt(i + 1) === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (c === '"') inDouble = true;
    else if (c === "'") inSingle = true;
    else if (c === '#') {
      const prev = i === 0 ? ' ' : s.charAt(i - 1);
      if (prev === ' ' || prev === '\t') return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

/** フローコレクションの括弧・引用符が全て閉じているか(複数行結合の終了判定) */
function isFlowBalanced(s: string): boolean {
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (inDouble) {
      if (c === '\\') i++;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (c === "'") {
        if (s.charAt(i + 1) === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (c === '"') inDouble = true;
    else if (c === "'") inSingle = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0 && !inSingle && !inDouble;
}

/** プレーンスカラーを null / bool / 数値 / 文字列へ変換(YAML 1.2 core schema 相当) */
function coerceScalar(s: string): YamlValue {
  const t = s.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^[+-]?\d+$/.test(t)) {
    const n = Number(t);
    if (Number.isSafeInteger(n)) return n;
    return t; // 精度が失われる巨大整数は文字列のまま返す
  }
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(2), 16);
  if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
  if (/[.eE]/.test(t) && /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  if (/^[+-]?\.(inf|Inf|INF)$/.test(t)) return t.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(t)) return NaN;
  return t;
}

function scalarToKey(v: YamlValue): string {
  if (typeof v === 'string') return v;
  if (v === null) return 'null';
  return String(v);
}

/** フロー構文([...] / {...} / 引用符 / プレーン)の1行(結合済み)テキストパーサ */
class FlowParser {
  private pos = 0;
  constructor(
    private readonly s: string,
    private readonly line: number,
  ) {}

  skipWs(): void {
    while (this.pos < this.s.length) {
      const c = this.s.charAt(this.pos);
      if (c !== ' ' && c !== '\t') break;
      this.pos++;
    }
  }

  atEnd(): boolean {
    return this.pos >= this.s.length;
  }

  rest(): string {
    return this.s.slice(this.pos);
  }

  private peek(): string {
    return this.s.charAt(this.pos);
  }

  parseValue(stopAtColon = false): YamlValue {
    this.skipWs();
    const c = this.peek();
    if (c === '') throw new YamlError(this.line, '値が空');
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseObject();
    if (c === '"') return this.parseDoubleQuoted();
    if (c === "'") return this.parseSingleQuoted();
    let out = '';
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === ',' || ch === ']' || ch === '}') break;
      if (stopAtColon && ch === ':') break;
      out += ch;
      this.pos++;
    }
    return coerceScalar(out);
  }

  private parseArray(): YamlValue[] {
    this.pos++; // '['
    const arr: YamlValue[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === ']') {
        this.pos++;
        return arr;
      }
      if (this.atEnd()) throw new YamlError(this.line, "']' が見つからない");
      arr.push(this.parseValue());
      this.skipWs();
      const c = this.peek();
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === ']') {
        this.pos++;
        return arr;
      }
      throw new YamlError(this.line, `配列内で ',' か ']' が必要(残り: "${this.rest().slice(0, 20)}")`);
    }
  }

  private parseObject(): { [key: string]: YamlValue } {
    this.pos++; // '{'
    const obj = Object.create(null) as { [key: string]: YamlValue };
    for (;;) {
      this.skipWs();
      if (this.peek() === '}') {
        this.pos++;
        return obj;
      }
      if (this.atEnd()) throw new YamlError(this.line, "'}' が見つからない");
      const key = this.parseValue(true);
      this.skipWs();
      let value: YamlValue = null;
      if (this.peek() === ':') {
        this.pos++;
        value = this.parseValue();
        this.skipWs();
      }
      obj[scalarToKey(key)] = value;
      const c = this.peek();
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === '}') {
        this.pos++;
        return obj;
      }
      throw new YamlError(this.line, `オブジェクト内で ',' か '}' が必要(残り: "${this.rest().slice(0, 20)}")`);
    }
  }

  private parseDoubleQuoted(): string {
    this.pos++; // '"'
    let out = '';
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === '"') {
        this.pos++;
        return out;
      }
      if (c === '\\') {
        this.pos++;
        const e = this.peek();
        this.pos++;
        switch (e) {
          case 'n':
            out += '\n';
            break;
          case 't':
            out += '\t';
            break;
          case 'r':
            out += '\r';
            break;
          case '0':
            out += '\0';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'u': {
            const hex = this.s.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new YamlError(this.line, '不正な \\u エスケープ(16進4桁が必要)');
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            out += e;
        }
        continue;
      }
      out += c;
      this.pos++;
    }
    throw new YamlError(this.line, '二重引用符(")が閉じていない');
  }

  private parseSingleQuoted(): string {
    this.pos++; // "'"
    let out = '';
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === "'") {
        if (this.s.charAt(this.pos + 1) === "'") {
          out += "'";
          this.pos += 2;
          continue;
        }
        this.pos++;
        return out;
      }
      out += c;
      this.pos++;
    }
    throw new YamlError(this.line, "単一引用符(')が閉じていない");
  }
}

/** 1行分のスカラーテキスト(引用符付き or プレーン)をパースする */
function parseScalarText(text: string, lineNo: number): YamlValue {
  const c0 = text.charAt(0);
  if (c0 === '"' || c0 === "'") {
    const fp = new FlowParser(text, lineNo);
    const v = fp.parseValue();
    fp.skipWs();
    if (!fp.atEnd()) {
      throw new YamlError(lineNo, `引用符の後に余分な文字: "${fp.rest().slice(0, 20)}"`);
    }
    return v;
  }
  return coerceScalar(text);
}

function parseFlowString(text: string, lineNo: number): YamlValue {
  const fp = new FlowParser(text, lineNo);
  const v = fp.parseValue();
  fp.skipWs();
  if (!fp.atEnd()) {
    throw new YamlError(lineNo, `フロー値の後に余分な文字: "${fp.rest().slice(0, 20)}"`);
  }
  return v;
}

/** インデントベースのブロック構造パーサ(1ドキュメント分) */
class DocParser {
  private i = 0;
  constructor(private readonly lines: SrcLine[]) {}

  private effective(l: SrcLine): string {
    return stripComment(l.content);
  }

  private skipBlank(): void {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (!l || this.effective(l).trim() !== '') break;
      this.i++;
    }
  }

  parseDocument(): YamlValue {
    this.skipBlank();
    const first = this.lines[this.i];
    if (!first) return null;
    const value = this.parseNode(first.indent);
    this.skipBlank();
    const extra = this.lines[this.i];
    if (extra) {
      throw new YamlError(extra.lineNo, `予期しない行: "${this.effective(extra)}"(インデントを確認)`);
    }
    return value;
  }

  private isSeqItem(content: string): boolean {
    return content === '-' || content.startsWith('- ');
  }

  private parseNode(indent: number): YamlValue {
    this.skipBlank();
    const line = this.lines[this.i];
    if (!line || line.indent < indent) return null;
    const content = this.effective(line);
    if (this.isSeqItem(content)) return this.parseSequence(line.indent);
    if (this.findMappingColon(content) >= 0) return this.parseMapping(line.indent);
    this.i++;
    return this.parseInlineValue(content, line);
  }

  /** 引用符・フロー括弧の外にあり、直後が空白/行末の ':' の位置を返す(なければ -1) */
  private findMappingColon(s: string): number {
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (inDouble) {
        if (c === '\\') i++;
        else if (c === '"') inDouble = false;
        continue;
      }
      if (inSingle) {
        if (c === "'") {
          if (s.charAt(i + 1) === "'") i++;
          else inSingle = false;
        }
        continue;
      }
      if (c === '"') inDouble = true;
      else if (c === "'") inSingle = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ':' && depth === 0) {
        const next = s.charAt(i + 1);
        if (next === '' || next === ' ' || next === '\t') return i;
      }
    }
    return -1;
  }

  private parseMapping(indent: number): YamlValue {
    const obj = Object.create(null) as { [key: string]: YamlValue };
    for (;;) {
      this.skipBlank();
      const line = this.lines[this.i];
      if (!line || line.indent < indent) break;
      if (line.indent > indent) {
        throw new YamlError(line.lineNo, `インデントが不正(${indent}桁のマッピング内で${line.indent}桁)`);
      }
      const content = this.effective(line);
      if (this.isSeqItem(content)) {
        throw new YamlError(line.lineNo, 'マッピングとシーケンスを同じインデントで混在できない');
      }
      const ci = this.findMappingColon(content);
      if (ci < 0) {
        throw new YamlError(line.lineNo, `マッピングの区切り ':' が見つからない: "${content.slice(0, 40)}"`);
      }
      const key = this.parseKey(content.slice(0, ci).trim(), line.lineNo);
      const rest = content.slice(ci + 1).trim();
      this.i++;
      let value: YamlValue;
      if (rest !== '') {
        value = this.parseInlineValue(rest, line);
      } else {
        this.skipBlank();
        const next = this.lines[this.i];
        if (
          next &&
          (next.indent > indent ||
            (next.indent === indent && this.isSeqItem(this.effective(next))))
        ) {
          value = this.parseNode(next.indent);
        } else {
          value = null;
        }
      }
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return obj;
  }

  private parseKey(text: string, lineNo: number): string {
    if (text === '') throw new YamlError(lineNo, 'マッピングのキーが空');
    if (text === '?' || text.startsWith('? ')) {
      throw new YamlError(lineNo, '複雑キー(? 構文)は未対応');
    }
    if (text.startsWith('"') || text.startsWith("'")) {
      return scalarToKey(parseScalarText(text, lineNo));
    }
    return text;
  }

  private parseSequence(indent: number): YamlValue {
    const arr: YamlValue[] = [];
    for (;;) {
      this.skipBlank();
      const line = this.lines[this.i];
      if (!line || line.indent < indent) break;
      const content = this.effective(line);
      if (!this.isSeqItem(content)) break; // 同インデントの親マッピングキーへ戻る
      if (line.indent > indent) {
        throw new YamlError(line.lineNo, `インデントが不正(${indent}桁のシーケンス内で${line.indent}桁)`);
      }
      if (content === '-') {
        this.i++;
        this.skipBlank();
        const next = this.lines[this.i];
        if (next && next.indent > indent) arr.push(this.parseNode(next.indent));
        else arr.push(null);
        continue;
      }
      // "- xxx": '-' を消して残りを独立したノードとして再パースする
      // (コンパクトマッピング "- name: x" やネスト "- - 1" も同じ仕組みで処理できる)
      let k = 1;
      while (content.charAt(k) === ' ') k++;
      const restIndent = line.indent + k;
      const sub: SrcLine = {
        raw: line.raw,
        indent: restIndent,
        content: line.content.slice(k),
        lineNo: line.lineNo,
        blank: false,
      };
      this.lines[this.i] = sub;
      arr.push(this.parseNode(restIndent));
    }
    return arr;
  }

  /** "key:" や "-" の後ろに書かれた値(スカラー/フロー/ブロックスカラー)をパースする */
  private parseInlineValue(text: string, line: SrcLine): YamlValue {
    const c0 = text.charAt(0);
    if (c0 === '&' || c0 === '*') {
      throw new YamlError(line.lineNo, `アンカー/エイリアス(${c0})は未対応`);
    }
    if (c0 === '|' || c0 === '>') {
      const m = /^([|>])([+-]?\d*|\d*[+-]?)$/.exec(text);
      if (m) {
        return this.parseBlockScalar(m[1] === '|' ? 'literal' : 'folded', m[2] ?? '', line);
      }
    }
    if (c0 === '[' || c0 === '{') {
      return parseFlowString(this.gatherFlow(text, line), line.lineNo);
    }
    return parseScalarText(text, line.lineNo);
  }

  /** 複数行にまたがるフローコレクションを1つの文字列に結合する */
  private gatherFlow(text: string, startLine: SrcLine): string {
    let buf = text;
    while (!isFlowBalanced(buf)) {
      const next = this.lines[this.i];
      if (!next) {
        throw new YamlError(
          startLine.lineNo,
          `フローコレクション('${text.charAt(0)}' 開始)が閉じていない`,
        );
      }
      this.i++;
      buf += ` ${this.effective(next).trim()}`;
    }
    return buf;
  }

  private parseBlockScalar(
    kind: 'literal' | 'folded',
    indicators: string,
    headerLine: SrcLine,
  ): string {
    let chomp: 'clip' | 'strip' | 'keep' = 'clip';
    if (indicators.includes('-')) chomp = 'strip';
    if (indicators.includes('+')) chomp = 'keep';
    const digit = /\d/.exec(indicators);
    const parentIndent = headerLine.indent;
    let blockIndent = digit ? parentIndent + Number(digit[0]) : -1;

    const collected: string[] = [];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (!l) break;
      if (l.blank) {
        collected.push('');
        this.i++;
        continue;
      }
      if (l.indent <= parentIndent) break;
      if (blockIndent < 0) blockIndent = l.indent;
      if (l.indent < blockIndent) {
        throw new YamlError(l.lineNo, `ブロックスカラーのインデントが不足(${blockIndent}桁必要)`);
      }
      collected.push(l.raw.slice(blockIndent));
      this.i++;
    }

    let trailing = 0;
    while (collected.length > 0 && collected[collected.length - 1] === '') {
      collected.pop();
      trailing++;
    }

    let text: string;
    if (kind === 'literal') {
      text = collected.join('\n');
    } else {
      const parts: string[] = [];
      let cur: string[] = [];
      for (const cl of collected) {
        if (cl === '') {
          parts.push(cur.join(' '));
          cur = [];
        } else {
          cur.push(cl);
        }
      }
      parts.push(cur.join(' '));
      text = parts.join('\n');
    }

    if (chomp === 'strip') return text;
    if (chomp === 'keep') return `${text}\n${'\n'.repeat(trailing)}`;
    return text === '' ? '' : `${text}\n`;
  }
}

/** '---' / '...' でドキュメント分割してそれぞれパースする */
export function parseYamlDocuments(text: string): { docs: YamlValue[]; multi: boolean } {
  const lines = toLines(text);
  const segments: SrcLine[][] = [];
  let cur: SrcLine[] = [];
  let openedByMarker = false;

  const curIsBlank = (): boolean => cur.every((l) => stripComment(l.content).trim() === '');

  for (const l of lines) {
    const c = stripComment(l.content);
    if (l.indent === 0 && (c === '---' || c.startsWith('--- '))) {
      if (segments.length === 0 && !openedByMarker && curIsBlank()) {
        // 先頭の '---' はドキュメント開始マーカーとして読み飛ばす
      } else {
        segments.push(cur);
      }
      cur = [];
      openedByMarker = true;
      const rest = l.content.slice(3);
      const trimmed = rest.trimStart();
      if (stripComment(trimmed).trim() !== '') {
        const offset = 3 + (rest.length - trimmed.length);
        cur.push({
          raw: l.raw,
          indent: offset,
          content: trimmed,
          lineNo: l.lineNo,
          blank: false,
        });
      }
      continue;
    }
    if (l.indent === 0 && c === '...') {
      segments.push(cur);
      cur = [];
      openedByMarker = false;
      continue;
    }
    cur.push(l);
  }
  if (openedByMarker || !curIsBlank() || segments.length === 0) segments.push(cur);

  const docs = segments.map((seg) => new DocParser(seg).parseDocument());
  return { docs, multi: docs.length > 1 };
}

export default {
  name: 'yaml_to_json',
  description:
    'YAMLテキストまたはYAMLファイルをJSONに変換する。yaml(生テキスト)か path(ワークスペース内のYAMLファイル)のどちらか一方を指定。pretty(既定true)で整形、indent で幅指定(既定2)。複数ドキュメント(---区切り)はJSON配列として返す。パースエラーは行番号付きで報告する。',
  inputSchema: {
    type: 'object',
    properties: {
      yaml: { type: 'string', description: '変換するYAMLテキスト(path と排他)' },
      path: { type: 'string', description: 'YAMLファイルのパス(相対はcwd基準。yaml と排他)' },
      pretty: { type: 'boolean', description: 'インデント整形して出力する(既定 true)' },
      indent: { type: 'integer', description: '整形時のインデント幅 0〜10(既定 2)' },
    },
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  pathParams: ['path'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { yaml, path, pretty, indent } = input as {
      yaml?: unknown;
      path?: unknown;
      pretty?: unknown;
      indent?: unknown;
    };

    const hasYaml = typeof yaml === 'string';
    const hasPath = typeof path === 'string' && path !== '';
    if (hasYaml === hasPath) {
      return {
        content: 'yaml(生テキスト)または path(YAMLファイル)のどちらか一方を指定すること',
        isError: true,
      };
    }
    if (pretty !== undefined && typeof pretty !== 'boolean') {
      return { content: 'pretty は boolean で指定すること', isError: true };
    }
    if (
      indent !== undefined &&
      (typeof indent !== 'number' || !Number.isInteger(indent) || indent < 0 || indent > 10)
    ) {
      return { content: 'indent は 0〜10 の整数で指定すること', isError: true };
    }

    let text: string;
    if (typeof yaml === 'string') {
      text = yaml;
    } else if (typeof path !== 'string') {
      return { content: 'path は文字列で指定すること', isError: true };
    } else {
      const abs = isAbsolute(path) ? path : resolve(ctx.cwd, path);
      const st = await stat(abs).catch(() => null);
      if (!st || !st.isFile()) return { content: `ファイルが存在しない: ${abs}`, isError: true };
      if (st.size > MAX_FILE_SIZE) {
        return {
          content: `ファイルが大きすぎる(${(st.size / 1024 / 1024).toFixed(1)}MB > 上限${MAX_FILE_SIZE / 1024 / 1024}MB): ${abs}`,
          isError: true,
        };
      }
      text = await readFile(abs, 'utf8');
      if (text.includes('\x00')) return { content: `バイナリファイルは変換できない: ${abs}`, isError: true };
    }

    const prettyOn = pretty === undefined ? true : pretty;
    const width = indent === undefined ? 2 : indent;

    try {
      const { docs, multi } = parseYamlDocuments(text);
      const value: YamlValue = multi ? docs : (docs[0] ?? null);
      const json = prettyOn ? JSON.stringify(value, null, width) : JSON.stringify(value);
      if (typeof json !== 'string') {
        return { content: 'JSONへ変換できない値になった', isError: true };
      }
      if (json.length > MAX_OUTPUT_CHARS) {
        return {
          content: `変換結果が大きすぎる(${json.length}文字 > 上限${MAX_OUTPUT_CHARS}文字)。ファイルを分割すること`,
          isError: true,
        };
      }
      return { content: json };
    } catch (e) {
      if (e instanceof YamlError) {
        return { content: `YAML parse error at line ${e.line}: ${e.message}`, isError: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { content: `YAML変換に失敗: ${msg}`, isError: true };
    }
  },
} satisfies ToolPlugin;
