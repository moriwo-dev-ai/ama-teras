import type { EvolutionScope } from '../../shared/types';

/**
 * M20: 進化スコープの段階的書き込み許可。
 * - tool: 従来どおりプラグインのみ(EVOLUTION_WRITE_ALLOWLIST と同一。guardrailsで固定)
 * - renderer: src/renderer のみ。src/shared は含めない(型変更は main に波及するため core 扱い)
 * - core: src/main + src/shared + src/renderer。聖域(PROTECTED_PATHS)は
 *   スコープに関わらず protected トリップワイヤが常に控除する
 */
export const SCOPE_ALLOWLISTS: Record<EvolutionScope, string[]> = {
  tool: ['src/main/tools/plugins'],
  renderer: ['src/renderer'],
  core: ['src/main', 'src/shared', 'src/renderer'],
};

/** 厳しさ順(宣言と推定が食い違ったら大きい方=厳しい側を採用) */
export const SCOPE_SEVERITY: Record<EvolutionScope, number> = { tool: 0, renderer: 1, core: 2 };

export function isEvolutionScope(v: unknown): v is EvolutionScope {
  return v === 'tool' || v === 'renderer' || v === 'core';
}

/** 差分ファイル一覧から最小内包スコープを推定する */
export function inferScope(files: string[]): EvolutionScope {
  const norm = files.map((f) => f.replaceAll('\\', '/'));
  const inTool = (f: string): boolean => f.startsWith('src/main/tools/plugins/');
  const inRenderer = (f: string): boolean => f.startsWith('src/renderer/');
  if (norm.every(inTool)) return 'tool';
  if (norm.every((f) => inTool(f) || inRenderer(f))) return 'renderer';
  return 'core';
}

/** 厳しい側のスコープを返す */
export function stricterScope(a: EvolutionScope, b: EvolutionScope): EvolutionScope {
  return SCOPE_SEVERITY[a] >= SCOPE_SEVERITY[b] ? a : b;
}

/** renderer/core は再ビルド+再起動が必要 */
export function scopeRequiresRestart(scope: EvolutionScope): boolean {
  return scope !== 'tool';
}
