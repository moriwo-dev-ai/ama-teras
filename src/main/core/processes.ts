import { spawn, type ChildProcess } from 'node:child_process';
import type { BackgroundProcessSnapshot } from '../tools/types';

/**
 * M11-2: bash の background 実行を支えるプロセス管理。
 * - 出力はプロセスごとのリングバッファ(既定256KB)に保持し、超過分は先頭から切り捨てる
 * - kill は Windows では taskkill /T /F(子孫込み)、他OSでは detached で作った
 *   プロセスグループへの SIGKILL
 * - 進化ジョブ(restrictExec コンテキスト)には注入しない(guardrails.test.ts で固定)
 */

const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;

/**
 * Windows の子孫込み強制killコマンドの組み立て。
 * サンドボックス(Linux)では実行経路を通せないため、組み立てを単体テストで固定し、
 * 実際の動作は docs/M11-manual-test.md の実機確認に委ねる。
 */
export function windowsKillArgs(pid: number): { cmd: string; args: string[] } {
  return { cmd: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] };
}

interface ManagedProcess {
  id: number;
  command: string;
  child: ChildProcess;
  chunks: Buffer[];
  bufferedBytes: number;
  droppedBytes: number;
  running: boolean;
  exitCode: number | null;
  exitSignal: string | null;
}

export class ProcessManager {
  private readonly procs = new Map<number, ManagedProcess>();
  private nextId = 1;

  constructor(
    private readonly maxBufferBytes: number = DEFAULT_MAX_BUFFER_BYTES,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  start(command: string, cwd: string): { id: number; pid: number | undefined } {
    const id = this.nextId++;
    const child = spawn(command, {
      cwd,
      shell: true,
      // POSIX ではプロセスグループを作り、グループごと kill できるようにする。
      // Windows では taskkill /T が子孫を辿るため detached は不要(コンソール分離の副作用を避ける)
      detached: this.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    const mp: ManagedProcess = {
      id,
      command,
      child,
      chunks: [],
      bufferedBytes: 0,
      droppedBytes: 0,
      running: true,
      exitCode: null,
      exitSignal: null,
    };
    const append = (chunk: Buffer): void => {
      mp.chunks.push(chunk);
      mp.bufferedBytes += chunk.byteLength;
      // リングバッファ: 上限超過分を先頭から切り捨てる(droppedBytes が絶対位置の基準になる)
      while (mp.bufferedBytes > this.maxBufferBytes && mp.chunks.length > 0) {
        const head = mp.chunks[0];
        if (!head) break;
        const overflow = mp.bufferedBytes - this.maxBufferBytes;
        if (head.byteLength <= overflow) {
          mp.chunks.shift();
          mp.bufferedBytes -= head.byteLength;
          mp.droppedBytes += head.byteLength;
        } else {
          mp.chunks[0] = head.subarray(overflow);
          mp.bufferedBytes -= overflow;
          mp.droppedBytes += overflow;
        }
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      // spawn 失敗はエラーとして出力へ残す(bash_output で見える)
      append(Buffer.from(`\n[spawn エラー: ${err.message}]`, 'utf8'));
      mp.running = false;
      if (mp.exitCode === null && mp.exitSignal === null) mp.exitCode = -1;
    });
    child.on('close', (code, signal) => {
      mp.running = false;
      mp.exitCode = code;
      mp.exitSignal = signal;
    });
    this.procs.set(id, mp);
    return { id, pid: child.pid };
  }

  /** sinceByte(前回の totalBytes)以降の出力と実行状態を返す。未知idは undefined */
  read(id: number, sinceByte = 0): BackgroundProcessSnapshot | undefined {
    const mp = this.procs.get(id);
    if (!mp) return undefined;
    const total = mp.droppedBytes + mp.bufferedBytes;
    const start = Math.max(Math.min(sinceByte, total), mp.droppedBytes);
    const output = Buffer.concat(mp.chunks).subarray(start - mp.droppedBytes).toString('utf8');
    return {
      id,
      command: mp.command,
      running: mp.running,
      exitCode: mp.exitCode,
      exitSignal: mp.exitSignal,
      output,
      totalBytes: total,
      droppedBytes: mp.droppedBytes,
    };
  }

  kill(id: number): 'killed' | 'already-exited' | 'not-found' {
    const mp = this.procs.get(id);
    if (!mp) return 'not-found';
    if (!mp.running) return 'already-exited';
    this.killChild(mp.child);
    return 'killed';
  }

  /** セッションキャンセル・アプリ終了時: 実行中の全プロセスを止める */
  killAll(): void {
    for (const mp of this.procs.values()) {
      if (mp.running) this.killChild(mp.child);
    }
  }

  /** 実行中プロセス数(テスト・デバッグ用) */
  runningCount(): number {
    let n = 0;
    for (const mp of this.procs.values()) if (mp.running) n++;
    return n;
  }

  private killChild(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (this.platform === 'win32') {
      const { cmd, args } = windowsKillArgs(pid);
      spawn(cmd, args, { windowsHide: true, stdio: 'ignore' }).on('error', () => {
        // taskkill 自体が起動できない場合の最終手段(直接の子のみ)
        child.kill();
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL'); // detached で作ったプロセスグループごと
      } catch {
        child.kill('SIGKILL');
      }
    }
  }
}
