/**
 * M27-5: プラグインAPIバージョニング(互換性契約)。
 *
 * 現行の `ToolPlugin` インターフェース(name / description / inputSchema / risk /
 * warnings / pathParams / tags / execute(input, ctx))を **v1 として凍結**する。
 * semver運用: マイナー=後方互換の追加のみ、破壊的変更(フィールドの意味変更・削除・
 * execute シグネチャ変更)は**メジャーを上げる**こと。
 * プラグインが依存してよいのは ToolPlugin インターフェース+実行時に渡される
 * ToolContext のみ(src/main 内部への import は guardrails テストで機械検出)。
 */
export const PLUGIN_API_VERSION = '1.0.0';

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return 0;
}

/**
 * マニフェストの pluginApiVersion 範囲を本体APIバージョンが満たすか。
 * 対応形式(npm互換の最小サブセット):
 * - "^1" / "^1.2" / "^1.2.3" … メジャー一致 かつ 指定以上
 * - "~1.2" / "~1.2.3"        … メジャー・マイナー一致 かつ 指定以上
 * - "1" / "1.2"              … そのメジャー(・マイナー)の任意
 * - "1.2.3"                  … 完全一致
 * 解釈できない範囲は false(安全側=無効化)
 */
export function satisfiesApiRange(range: string, version: string = PLUGIN_API_VERSION): boolean {
  const v = parseVersion(version);
  if (v === null) return false;
  const r = range.trim();
  const body = r.replace(/^[\^~]/, '');
  const base = parseVersion(body);
  if (base === null || !/^[\^~]?\d+(\.\d+){0,2}$/.test(r)) return false;

  const parts = body.split('.').length;
  if (r.startsWith('^')) {
    return v[0] === base[0] && cmp(v, base) >= 0;
  }
  if (r.startsWith('~')) {
    return v[0] === base[0] && v[1] === base[1] && cmp(v, base) >= 0;
  }
  // 演算子なし: 指定した桁までの一致("1"=メジャー1の任意 / "1.2.3"=完全一致)
  if (parts === 1) return v[0] === base[0];
  if (parts === 2) return v[0] === base[0] && v[1] === base[1];
  return cmp(v, base) === 0;
}
