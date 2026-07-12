import { spawn } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
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

/** 一時WAVの名前。これで自分が書いたものだけを狙って消す */
const TMP_PREFIX = 'amateras-tsukuyomi-';

/**
 * 前回の残骸を掃除する(起動時に1回)。
 *
 * 通常運転なら finally が必ず消すが、**文字起こし中にアプリが落ちた/強制終了された**場合は
 * finally が走らず、録音が tmp に1本残る(実機で確認した)。
 * 「録音が残るアプリにしない」ためには、落ちた次の起動で拾い直すしかない
 */
export function sweepTmpWavs(dir: string = tmpdir()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(TMP_PREFIX) || !name.endsWith('.wav')) continue;
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch {
        /* 使用中なら次回に回す */
      }
    }
  } catch {
    /* tmp が読めない環境なら何もしない */
  }
  return removed;
}

const TRANSCRIBE_TIMEOUT_MS = 120_000;

/**
 * 使うスレッド数。既定(4)のままだと20コアのPCでも4しか使わず遅い
 * (実機: 2秒の音声に 29秒 → -t 8 と貪欲デコードで 21秒)。
 * 全コアは使わない — 月読は裏方であって、他の作業を止めてはいけない
 */
export function threadCount(cores: number): number {
  return Math.max(2, Math.min(8, cores - 2));
}

/**
 * whisper の引数。
 * -nt(タイムスタンプなし)/ --no-prints(ログ抑制)/ -bs 1(貪欲デコード=速い)。
 * 精度より速度を採る — 拾うのは「約束・ToDo」で、一字一句の正確さは要らない
 */
export function whisperArgs(model: string, wavPath: string, cores: number): string[] {
  return [
    '-m',
    model,
    '-f',
    wavPath,
    '-l',
    'ja',
    '-nt',
    '--no-prints',
    '-t',
    String(threadCount(cores)),
    '-bs',
    '1',
  ];
}

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

/**
 * whisper が無音・雑音に対して出す幻聴。**そのまま通すと帳がゴミで埋まる**
 * (実機で無音2秒に「(音楽)」が返ってきた)。括弧だけの行は全部落とす
 */
const HALLUCINATION_RE = /^[[(【（].*[\])】）]$/;

/** whisper-cli の出力からテキストだけを取り出す(タイムスタンプ行・幻聴を落とす) */
export function parseWhisperOutput(raw: string): string {
  return raw
    .split('\n')
    .map((line) => {
      // "[00:00:00.000 --> 00:00:03.000]   本文" の形。タイムスタンプが無ければ行そのもの
      const m = /^\[[\d:.]+\s*-->\s*[\d:.]+\]\s*(.*)$/.exec(line.trim());
      return (m?.[1] ?? line).trim();
    })
    // 実行ログ("read_audio_data: ..." 等)と幻聴("(音楽)" "[BLANK_AUDIO]")を落とす
    .filter((t) => t !== '' && !HALLUCINATION_RE.test(t) && !/^\w+_?\w*:\s/.test(t))
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
  const wavPath = join(dir, `${TMP_PREFIX}${randomUUID()}.wav`);
  const run = opts.runner ?? defaultRunner(paths.bin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  const signal =
    opts.signal !== undefined ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;

  try {
    writeFileSync(wavPath, wav);
    const raw = await run(whisperArgs(paths.model, wavPath, cpus().length), signal);
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
