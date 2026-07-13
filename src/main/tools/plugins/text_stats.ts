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

/**
 * チャンク単位で逐次集計できるカウンタ(wc 相当)。
 * 大きなファイルでも全文をメモリに保持せずに統計を出す。
 * - lines: 既存互換('\n' の数 + 1。空入力は 0)
 * - words: 空白区切り(Unicode \s)のトークン数。チャンク境界をまたぐ単語も正しく1語と数える
 * - chars: Unicode コードポイント数(Array.from 相当)
 * - bytes: UTF-8 バイト数
 */
class StatsCounter {
  private newlines = 0;
  private words = 0;
  private chars = 0;
  private bytes = 0;
  private inWord = false;
  private hasContent = false;

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.hasContent = true;
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    for (const ch of chunk) {
      this.chars += 1;
      if (ch === '\n') this.newlines += 1;
      if (/\s/u.test(ch)) {
        this.inWord = false;
      } else {
        if (!this.inWord) this.words += 1;
        this.inWord = true;
      }
    }
  }

  result(): TextStatsResult {
    return {
      chars: this.chars,
      lines: this.hasContent ? this.newlines + 1 : 0,
      words: this.words,
      bytes: this.bytes,
    };
  }
}

function computeStats(content: string): TextStatsResult {
  const counter = new StatsCounter();
  counter.push(content);
  return counter.result();
}

/**
 * ファイルをストリーミングで読みながら集計する(全文をメモリに載せない)。
 * encoding:'utf8' の ReadStream は内部の StringDecoder がチャンク境界の
 * マルチバイト文字を正しくバッファするため、日本語混在テキストでも安全。
 */
async function computeFileStats(relPath: string, ctx: ToolContext): Promise<TextStatsResult> {
  const nodePath = await import('node:path');
  const fs = await import('node:fs');
  const fullPath = nodePath.resolve(ctx.cwd, relPath);
  const counter = new StatsCounter();

  await new Promise<void>((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const stream = fs.createReadStream(fullPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    const onAbort = () => {
      stream.destroy(new Error('Aborted'));
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => {
      counter.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    stream.on('end', () => {
      ctx.signal.removeEventListener('abort', onAbort);
      resolve();
    });
    stream.on('error', (err) => {
      ctx.signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });

  return counter.result();
}

const plugin: ToolPlugin = {
  name: 'text_stats',
  description: 'Compute basic statistics for a given text or file: character count, line count, word count (whitespace-delimited), and byte size (UTF-8). Files are read as a stream, so large files are handled without loading the whole content into memory. Supports mixed Japanese and English text.',
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

    if (text === undefined && !path) {
      return { content: 'Invalid input: at least one of "text" or "path" must be provided.', isError: true };
    }

    try {
      // text が与えられたら text を優先(従来互換)。それ以外は path をストリーミング集計
      const stats =
        text !== undefined ? computeStats(text) : await computeFileStats(path ?? '', ctx);
      return { content: JSON.stringify(stats) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: `Failed to compute text stats: ${message}`, isError: true };
    }
  },
};

export default plugin;
