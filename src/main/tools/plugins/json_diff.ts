import type { ToolContext, ToolPlugin, ToolResult } from '../types';

/**
 * json_diff: 2つのJSON値を再帰的に比較して差分を列挙する純粋計算ツール。
 * - 追加(bにのみある)・削除(aにのみある)・変更(値や型が異なる)をパス付きで返す
 * - パスはドット記法(a.b[0].c)。識別子にできないキーは ["キー"] 表記でエスケープ
 * - 配列は添字ごとに比較(長さの差は added / removed)。オブジェクトはキーごとに再帰
 * - 型が異なる場合(例: object → array、number → string)はそのパスを changed 1件にまとめる
 * - ファイル・ネットワーク・child_process は一切使わない
 */

export type DiffEntry = { path: string; value: unknown };
export type ChangeEntry = { path: string; from: unknown; to: unknown };
export type DiffResult = {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: ChangeEntry[];
  same: boolean;
  truncated?: boolean;
};

const MAX_DEPTH = 200;
const MAX_ENTRIES = 5000;
const ROOT_LABEL = '(root)';
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function joinKey(base: string, key: string): string {
  const part = IDENT_RE.test(key) ? key : `[${JSON.stringify(key)}]`;
  if (base === '') return IDENT_RE.test(key) ? part : `${ROOT_LABEL}${part}`;
  return IDENT_RE.test(key) ? `${base}.${part}` : `${base}${part}`;
}

function joinIndex(base: string, index: number): string {
  return base === '' ? `${ROOT_LABEL}[${index}]` : `${base}[${index}]`;
}

function label(path: string): string {
  return path === '' ? ROOT_LABEL : path;
}

/** 2つのJSON値を再帰比較して差分を返す(公開: テスト用) */
export function diffJson(a: unknown, b: unknown): DiffResult {
  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: ChangeEntry[] = [];
  let truncated = false;

  const total = (): number => added.length + removed.length + changed.length;
  const push = <T>(arr: T[], entry: T): void => {
    if (total() >= MAX_ENTRIES) {
      truncated = true;
      return;
    }
    arr.push(entry);
  };

  const walk = (x: unknown, y: unknown, path: string, depth: number): void => {
    if (truncated) return;
    if (depth > MAX_DEPTH) {
      // 深すぎる場合はそれ以上潜らず、全体比較で決着させる
      if (JSON.stringify(x) !== JSON.stringify(y)) push(changed, { path: label(path), from: x, to: y });
      return;
    }

    // 同一プリミティブ(NaN・-0 も Object.is で区別)
    if (Object.is(x, y)) return;

    if (Array.isArray(x) && Array.isArray(y)) {
      const len = Math.max(x.length, y.length);
      for (let i = 0; i < len; i++) {
        const p = joinIndex(path, i);
        if (i >= x.length) {
          push(added, { path: p, value: y[i] });
        } else if (i >= y.length) {
          push(removed, { path: p, value: x[i] });
        } else {
          walk(x[i], y[i], p, depth + 1);
        }
      }
      return;
    }

    if (isPlainObject(x) && isPlainObject(y)) {
      const keys = new Set<string>([...Object.keys(x), ...Object.keys(y)]);
      for (const key of keys) {
        const p = joinKey(path, key);
        const inX = Object.prototype.hasOwnProperty.call(x, key);
        const inY = Object.prototype.hasOwnProperty.call(y, key);
        if (!inX && inY) {
          push(added, { path: p, value: y[key] });
        } else if (inX && !inY) {
          push(removed, { path: p, value: x[key] });
        } else {
          walk(x[key], y[key], p, depth + 1);
        }
      }
      return;
    }

    // 型が異なる(object vs array / primitive vs object など)か、値が異なるプリミティブ
    push(changed, { path: label(path), from: x, to: y });
  };

  walk(a, b, '', 0);
  const result: DiffResult = { added, removed, changed, same: total() === 0 && !truncated };
  if (truncated) result.truncated = true;
  return result;
}

export default {
  name: 'json_diff',
  description:
    '2つのJSON値を再帰的に比較して差分を出す。追加・削除・変更されたパスをドット記法' +
    '(例 a.b[0].c)で列挙し、変更は旧値→新値を示す。配列・ネストオブジェクト・型変更に対応。' +
    '外部依存なしの純粋計算で、結果を {added, removed, changed, same} のJSONで返す。',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'object', description: '比較元のJSON値(オブジェクト・配列・プリミティブ可)' },
      b: { type: 'object', description: '比較先のJSON値(オブジェクト・配列・プリミティブ可)' },
    },
    required: ['a', 'b'],
  },
  risk: 'safe',
  tags: ['テキスト処理'],
  async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
    if (typeof input !== 'object' || input === null) {
      return { content: '入力は { a, b } のオブジェクトであること', isError: true };
    }
    const obj = input as Record<string, unknown>;
    if (!('a' in obj) || !('b' in obj)) {
      return { content: '入力には a と b の両方が必要(null でも明示的に渡すこと)', isError: true };
    }
    try {
      const result = diffJson(obj['a'], obj['b']);
      return { content: JSON.stringify(result, null, 2) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `比較に失敗した: ${msg}(循環参照を含む値は比較できない)`, isError: true };
    }
  },
} satisfies ToolPlugin;
