/**
 * プラグイン(ツール)名として安全な文字列か判定する。
 * 進化ジョブが返す toolName は LLM 出力由来で、そのままシェルコマンドへ
 * 補間される経路(スモークゲート・健全性チェック)があるため、
 * シェルメタ文字・空白・パス区切りを含む名前を早期に弾く必要がある。
 */
const SAFE_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

export function isSafeToolName(name: unknown): name is string {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && SAFE_TOOL_NAME.test(name);
}

export function assertSafeToolName(name: unknown): asserts name is string {
  if (!isSafeToolName(name)) {
    throw new Error(
      `ツール名が不正(英数字・_・- のみ、1〜64文字): ${JSON.stringify(name).slice(0, 80)}`,
    );
  }
}
