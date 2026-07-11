import type { LLMProvider } from '../providers/types';

/**
 * M32: 運営機能の単発LLM補完(ツールなし・1往復)。
 * provider は service の帯(planner/reviewer)から注入される。
 */
export async function completeText(
  provider: LLMProvider,
  system: string,
  prompt: string,
  maxTokens = 4096,
): Promise<string> {
  let text = '';
  for await (const ev of provider.complete({
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    maxTokens,
    signal: AbortSignal.timeout(180_000),
  })) {
    if (ev.type === 'text_delta') text += ev.text;
  }
  return text;
}

/** LLM出力からJSONを取り出す(コードフェンス・前後の散文を許容)。失敗は null */
export function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced?.[1] ?? raw;
  const start = body.search(/[[{]/);
  if (start < 0) return null;
  // 末尾から対応する閉じ括弧を探す(素朴だが運営下書き用途には十分)
  for (let end = body.length; end > start; end--) {
    const slice = body.slice(start, end);
    try {
      return JSON.parse(slice);
    } catch {
      // 縮めて再試行
    }
  }
  return null;
}
