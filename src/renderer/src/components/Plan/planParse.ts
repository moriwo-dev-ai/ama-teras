/** M12-2: AMATERAS_PLAN.md のチェックボックス進捗パース(表示専用) */

export interface PlanItem {
  text: string;
  done: boolean;
}

export interface PlanProgress {
  items: PlanItem[];
  done: number;
  total: number;
}

const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s+(.*)$/;

export function parsePlanProgress(content: string): PlanProgress {
  const items: PlanItem[] = [];
  for (const line of content.split('\n')) {
    const m = CHECKBOX_RE.exec(line);
    if (m) items.push({ text: m[2] ?? '', done: m[1] !== ' ' });
  }
  return { items, done: items.filter((i) => i.done).length, total: items.length };
}
