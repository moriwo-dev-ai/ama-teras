import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * M42-5(TUKU-yomi): 耳 — ローカル音声認識(whisper.cpp)。
 *
 * **音声はAPIに送らない**(鉄則2)。文字起こしはこのPCの中だけで終わる。
 * 一時WAVは tmpdir に置き、**文字起こし直後に必ず削除**する(finally で保証・テストで固定)。
 * 生の文字起こしも抽出後に捨てる — 帳に残るのは抽出結果の一文だけ。
 */

/** whisper-cli とモデルの置き場(userData/tsukuyomi/models/) */
export interface WhisperPaths {
  /** whisper-cli.exe */
  bin: string;
  /** ggml-small.bin 等 */
  model: string;
}

export function whisperPaths(userDataDir: string): WhisperPaths {
  const dir = join(userDataDir, 'tsukuyomi', 'models');
  return { bin: join(dir, 'whisper-cli.exe'), model: join(dir, 'ggml-small.bin') };
}

/** 未配置なら UI に「モデル未配置」を出す(勝手にダウンロードしない) */
export function whisperReady(paths: WhisperPaths): boolean {
  return existsSync(paths.bin) && existsSync(paths.model);
}

export type WhisperRunner = (args: string[], signal: AbortSignal) => Promise<string>;

const TRANSCRIBE_TIMEOUT_MS = 120_000;

function defaultRunner(bin: string): WhisperRunner {
  return (args, signal) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.stderr.on('data', (c: Buffer) => {
        err += c.toString('utf8');
      });
      const onAbort = (): void => {
        child.kill();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (code === 0) resolve(out);
        else reject(new Error(err.trim() || `whisper が異常終了(code ${code})`));
      });
    });
}

/** whisper-cli の出力からテキストだけを取り出す(タイムスタンプ行を落とす) */
export function parseWhisperOutput(raw: string): string {
  return raw
    .split('\n')
    .map((line) => {
      // "[00:00:00.000 --> 00:00:03.000]   本文" の形。タイムスタンプが無ければ行そのもの
      const m = /^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.*)$/.exec(line.trim());
      return (m?.[1] ?? line).trim();
    })
    .filter((t) => t !== '' && !/^\[.*\]$/.test(t)) // [BLANK_AUDIO] 等を落とす
    .join(' ')
    .trim();
}

/**
 * WAV(16kHz mono)を文字起こしする。
 * **一時ファイルは必ず消す**(成功・失敗・タイムアウトのいずれでも finally で削除)
 */
export async function transcribe(
  wav: Buffer,
  paths: WhisperPaths,
  opts: { runner?: WhisperRunner; signal?: AbortSignal; tmpDir?: string } = {},
): Promise<string> {
  if (!whisperReady(paths)) throw new Error('whisper が未配置(モデル未配置)');

  const dir = opts.tmpDir ?? tmpdir();
  const wavPath = join(dir, `amateras-tsukuyomi-${randomUUID()}.wav`);
  const run = opts.runner ?? defaultRunner(paths.bin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  const signal =
    opts.signal !== undefined ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;

  try {
    writeFileSync(wavPath, wav);
    const raw = await run(
      ['-m', paths.model, '-f', wavPath, '-l', 'ja', '-nt', '--no-prints'],
      signal,
    );
    return parseWhisperOutput(raw);
  } finally {
    clearTimeout(timer);
    // 音声はここで消える。この行が消えたら「録音が残るアプリ」になる — 絶対に外さない
    try {
      unlinkSync(wavPath);
    } catch {
      /* 既に無い場合は何もしない */
    }
  }
}
