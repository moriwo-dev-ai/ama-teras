import { spawn } from 'node:child_process';

/**
 * M42-2(TUKU-yomi): 口のフォールバック。
 *
 * renderer の speechSynthesis に日本語の声が無い機体で使う。
 * Windows の System.Speech(OS同梱・ローカル)で読み上げる。**APIには何も送らない**。
 *
 * spawn の作法は bash.ts に倣う(windowsHide・タイムアウト・失敗しても落とさない)。
 * 喋れなくてもアプリの機能は続く(声は本質ではない)ので、失敗は false を返すだけ。
 */

export type Spawner = (command: string, args: string[]) => Promise<boolean>;

const SPEAK_TIMEOUT_MS = 15_000;

function defaultSpawner(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, SPEAK_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * PowerShell へ渡す前に、引用符と改行を落とす(コマンド組み立ての事故防止)。
 * 読み上げるのは月読が自分で作った短文だけなので、落として困る文字は無い
 */
export function sanitizeForPowerShell(text: string): string {
  return text.replace(/['"`$\r\n]/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
}

export async function speakWithPowerShell(text: string, spawner: Spawner = defaultSpawner): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const safe = sanitizeForPowerShell(text);
  if (safe === '') return false;
  return spawner('powershell', [
    '-NoProfile',
    '-Command',
    `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak('${safe}')`,
  ]);
}
