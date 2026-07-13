import { createReadStream } from 'node:fs';
import * as nodePath from 'node:path';
import type { ToolPlugin, ToolContext, ToolResult } from '../types';

interface WcFileInput {
  path: string;
}

interface WcFileResult {
  lines: number;
  words: number;
  chars: number;
}

function isWcFileInput(value: unknown): value is WcFileInput {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { [key: string]: unknown };
  return typeof v.path === 'string' && v.path.length > 0;
}

/**
 * wc 相当のカウンタ。チャンク単位で逐次集計できるため、
 * 大きなファイルでも全文をメモリに載せずに統計を出せる。
 * - lines: '\n' の個数(wc -l 相当。改行で終わらない最終行は数えない)
 * - words: 空白(Unicode \s)区切りのトークン数(wc -w 相当)。
 *   チャンク境界をまたぐ単語も inWord 状態を持ち越して正しく1語と数える
 * - chars: Unicode コードポイント数(wc -m 相当。サロゲートペアも1文字)
 */
class WcCounter {
  private lines = 0;
  private words = 0;
  private chars = 0;
  private inWord = false;

  push(chunk: string): void {
    for (const ch of chunk) {
      this.chars += 1;
      if (ch === '\n') this.lines += 1;
      if (/\s/u.test(ch)) {
        this.inWord = false;
      } else {
        if (!this.inWord) this.words += 1;
        this.inWord = true;
      }
    }
  }

  result(): WcFileResult {
    return { lines: this.lines, words: this.words, chars: this.chars };
  }
}

/**
 * ファイルをストリーミングで読みながら集計する(全文をメモリに保持しない)。
 * encoding:'utf8' の ReadStream は内部の StringDecoder がチャンク境界の
 * マルチバイト文字をバッファするため、日本語混在テキストでも安全。
 */
async function countFile(relPath: string, ctx: ToolContext): Promise<WcFileResult> {
  const fullPath = nodePath.resolve(ctx.cwd, relPath);
  const counter = new WcCounter();

  await new Promise<void>((resolve, reject) => {
    if (ctx.signal.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const stream = createReadStream(fullPath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
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

const plugin = {
  name: 'wc_file',
  description:
    'Count lines, words, and characters of a text file (wc equivalent). The file is read as a stream, so large files are handled without loading the whole content into memory. lines = number of newline characters (wc -l), words = whitespace-delimited tokens (wc -w), chars = Unicode code points (wc -m). Supports mixed Japanese and English text. Returns {lines, words, chars} as JSON.',
  risk: 'safe',
  tags: ['テキスト処理', 'ファイル操作'],
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to a UTF-8 text file, relative to the workspace root.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  pathParams: ['path'],
  async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!isWcFileInput(input)) {
      return {
        content: 'Invalid input: expected { path: string } with a non-empty path.',
        isError: true,
      };
    }

    try {
      const stats = await countFile(input.path, ctx);
      return { content: JSON.stringify(stats) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: `Failed to count file: ${message}`, isError: true };
    }
  },
} satisfies ToolPlugin;

export default plugin;
