import type { ToolPlugin, ToolContext, ToolResult } from '../types';

interface TextStatsInput {
  text?: string;
  path?: string;
}

interface TextStatsResult {
  chars: number;
  lines: number;
  words: number;
  bytes: number;
}

function isTextStatsInput(value: unknown): value is TextStatsInput {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { [key: string]: unknown };
  const hasText = Object.prototype.hasOwnProperty.call(v, 'text');
  const hasPath = Object.prototype.hasOwnProperty.call(v, 'path');
  if (!hasText && !hasPath) return false;
  if (hasText && typeof v.text !== 'string') return false;
  if (hasPath && typeof v.path !== 'string') return false;
  return true;
}

function computeStats(content: string): TextStatsResult {
  const chars = Array.from(content).length;
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const words = content.trim().length === 0 ? 0 : content.trim().split(/\s+/u).length;
  const bytes = Buffer.byteLength(content, 'utf8');
  return { chars, lines, words, bytes };
}

async function readFileContent(path: string, ctx: ToolContext): Promise<string> {
  const fs = await import('fs/promises');
  const fullPath = `${ctx.cwd}/${path}`;
  const data = await fs.readFile(fullPath, { encoding: 'utf8' });
  return data;
}

const plugin: ToolPlugin = {
  name: 'text_stats',
  description: 'Compute basic statistics for a given text or file: character count, line count, word count (whitespace-delimited), and byte size (UTF-8). Supports mixed Japanese and English text.',
  risk: 'safe',
  tags: ['テキスト処理'],
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Raw text to analyze.' },
      path: { type: 'string', description: 'Path to a UTF-8 text file, relative to the workspace root.' },
    },
    required: [],
    additionalProperties: false,
  },
  pathParams: ['path'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isTextStatsInput(input)) {
      return { content: 'Invalid input: expected object with optional string fields "text" and/or "path".', isError: true };
    }

    const { text, path } = input;

    if (!text && !path) {
      return { content: 'Invalid input: at least one of "text" or "path" must be provided.', isError: true };
    }

    try {
      let baseContent = '';
      if (path) {
        baseContent = await readFileContent(path, ctx);
      }

      const finalContent = text !== undefined ? text : baseContent;
      const stats = computeStats(finalContent);
      return { content: JSON.stringify(stats) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: `Failed to compute text stats: ${message}`, isError: true };
    }
  },
};

export default plugin;
