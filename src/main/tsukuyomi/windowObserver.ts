import { execFile } from 'node:child_process';

/**
 * M42-6(TUKU-yomi): PC窓観測 — フォアグラウンドウィンドウの**タイトルとプロセス名だけ**。
 *
 * **スクリーンショットは撮らない**。取るのは「何のアプリを見ているか」だけで、
 * 画面の中身は一切見ない(見たものは覚えるが、見たままは残さない)。
 * 帳には observation として一文が残り、7日で忘れる。
 *
 * spawn はラッパを注入できる(テストは偽実装。実行はPowerShellの1行)。
 */

export type ShellRunner = (command: string, args: string[]) => Promise<string>;

const TIMEOUT_MS = 10_000;

function defaultRunner(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * PowerShell の1行。GetForegroundWindow でハンドルを取り、
 * そのプロセスの **MainWindowTitle と ProcessName だけ** を返す
 */
export const FOREGROUND_PS = [
  'Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}\';',
  '$p=0;[void][W]::GetWindowThreadProcessId([W]::GetForegroundWindow(),[ref]$p);',
  '$proc=Get-Process -Id $p -ErrorAction SilentlyContinue;',
  'if($proc){ "$($proc.ProcessName)`t$($proc.MainWindowTitle)" }',
].join(' ');

export interface ForegroundWindow {
  process: string;
  title: string;
}

/** 出力(process<TAB>title)をパースする。空なら null */
export function parseForeground(raw: string): ForegroundWindow | null {
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l !== '');
  if (line === undefined) return null;
  const [process, ...rest] = line.split('\t');
  if (process === undefined || process === '') return null;
  return { process, title: rest.join('\t').trim() };
}

/** 帳に残す一文。タイトルは長いので切る(中身の説明はしない) */
export function windowText(w: ForegroundWindow, now: Date): string {
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const title = w.title === '' ? '(タイトルなし)' : w.title.length > 40 ? `${w.title.slice(0, 40)}…` : w.title;
  return `${hhmm} ${w.process}: ${title}`;
}

export async function foregroundWindow(runner: ShellRunner = defaultRunner): Promise<ForegroundWindow | null> {
  if (process.platform !== 'win32') return null;
  try {
    return parseForeground(await runner('powershell', ['-NoProfile', '-Command', FOREGROUND_PS]));
  } catch {
    return null; // 取れなくても騒がない(観測は本質ではない)
  }
}
