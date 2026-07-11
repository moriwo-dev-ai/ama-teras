import type { LLMProvider } from '../providers/types';

/**
 * M32: 運営機能の単発LLM補完(ツールなし・1往復)。
 * provider は service の帯(planner/reviewer/worker等)から注入される。
 * M33: 神々の1日トークン予算のため、消費トークン(入出力合計)も返す。
 */
export async function completeTextWithUsage(
  provider: LLMProvider,
  system: string,
  prompt: string,
  maxTokens = 4096,
): Promise<{ text: string; tokensUsed: number }> {
  let text = '';
  let tokensUsed = 0;
  for await (const ev of provider.complete({
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    maxTokens,
    signal: AbortSignal.timeout(180_000),
  })) {
    if (ev.type === 'text_delta') text += ev.text;
    if (ev.type === 'message_done') {
      tokensUsed = ev.usage.inputTokens + ev.usage.outputTokens;
    }
  }
  return { text, tokensUsed };
}

/** 後方互換(M32呼び出し元用): テキストのみ */
export async function completeText(
  provider: LLMProvider,
  system: string,
  prompt: string,
  maxTokens = 4096,
): Promise<string> {
  return (await completeTextWithUsage(provider, system, prompt, maxTokens)).text;
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
