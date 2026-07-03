/**
 * ツール呼び出しの引数JSON(ストリームで分割到着し連結された文字列)を解析する。
 * 解析失敗を握りつぶして {} に差し替えると、ツールが空入力で実行され無関係な
 * バリデーションエラーになりモデルが原因を掴めずループする(指摘#7)。
 * 失敗時は error を返して呼び出し側で表面化できるようにする。両プロバイダ共通。
 */
export function parseToolArguments(raw: string): { input: unknown; error?: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { input: {} };
  try {
    return { input: JSON.parse(trimmed) };
  } catch {
    return {
      input: {},
      error:
        'ツール引数のJSON解析に失敗した(応答が途中で切れた可能性)。' +
        `受信した生データ: ${trimmed.slice(0, 200)}`,
    };
  }
}
