import { describe, expect, it } from 'vitest';
import { capabilitySummary } from './EvolutionPanel';

describe('capabilitySummary(昇格履歴の能力要約)', () => {
  const descs = {
    text_stats: 'Compute basic statistics for a given text or file: character count, line count, word count.',
    csv_to_markdown: 'Convert CSV text into a Markdown table string.',
  };

  it('tool 昇格: 単一ツールならツール説明そのものが要約になる', () => {
    const s = capabilitySummary(
      { kind: 'tool', toolNames: ['text_stats'], subject: 'evolve: job-1 を昇格' },
      descs,
    );
    expect(s).toBe(descs.text_stats);
  });

  it('tool 昇格: 複数ツールなら「name: 説明」を連結する', () => {
    const s = capabilitySummary(
      { kind: 'tool', toolNames: ['text_stats', 'csv_to_markdown'], subject: 'evolve: job-2 を昇格' },
      descs,
    );
    expect(s).toContain(`text_stats: ${descs.text_stats}`);
    expect(s).toContain(`csv_to_markdown: ${descs.csv_to_markdown}`);
  });

  it('tool 昇格: 説明が引けない(アンロード済み等)場合は subject にフォールバック', () => {
    const s = capabilitySummary(
      { kind: 'tool', toolNames: ['unknown_tool'], subject: 'evolve: job-3 を昇格' },
      descs,
    );
    expect(s).toBe('evolve: job-3 を昇格');
  });

  it('renderer/core 昇格: マージコミットの subject が要約になる', () => {
    const s = capabilitySummary(
      { kind: 'core', toolNames: [], subject: 'evolve: job-4 を昇格' },
      descs,
    );
    expect(s).toBe('evolve: job-4 を昇格');
  });
});
