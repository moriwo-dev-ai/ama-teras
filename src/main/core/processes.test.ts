import { describe, expect, it } from 'vitest';
import { ProcessManager, windowsKillArgs } from './processes';

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor タイムアウト');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('ProcessManager(M11-2)', () => {
  it('起動→出力取得→kill→終了状態の基本フロー', async () => {
    const pm = new ProcessManager();
    const { id, pid } = pm.start(
      `node -e "console.log('ready'); setInterval(() => {}, 1000)"`,
      process.cwd(),
    );
    expect(pid).toBeGreaterThan(0);
    await waitFor(() => (pm.read(id)?.output ?? '').includes('ready'));
    expect(pm.read(id)?.running).toBe(true);

    expect(pm.kill(id)).toBe('killed');
    await waitFor(() => pm.read(id)?.running === false);
    const snap = pm.read(id);
    expect(snap).toBeDefined();
    // SIGKILL(POSIX)なら exitSignal、環境によっては非ゼロ exitCode
    expect(snap!.exitSignal !== null || snap!.exitCode !== 0).toBe(true);
    expect(pm.kill(id)).toBe('already-exited');
  });

  it('sinceByte で増分だけ取得できる', async () => {
    const pm = new ProcessManager();
    const { id } = pm.start(
      `node -e "process.stdout.write('AAAA'); setTimeout(() => process.stdout.write('BBBB'), 150)"`,
      process.cwd(),
    );
    await waitFor(() => pm.read(id)?.running === false);
    expect(pm.read(id)!.output).toBe('AAAABBBB');
    const tail = pm.read(id, 4)!;
    expect(tail.output).toBe('BBBB');
    expect(tail.totalBytes).toBe(8);
  });

  it('リングバッファ境界: 上限超過分は先頭から切り捨てられ droppedBytes に載る', async () => {
    const pm = new ProcessManager(16); // テスト用に極小上限
    const { id } = pm.start(`node -e "process.stdout.write('0123456789abcdefGHIJ')"`, process.cwd());
    await waitFor(() => pm.read(id)?.running === false);
    const snap = pm.read(id)!;
    expect(snap.totalBytes).toBe(20);
    expect(snap.droppedBytes).toBe(4);
    expect(snap.output).toBe('456789abcdefGHIJ');
    // 切り捨て済み範囲を sinceByte で要求しても壊れない(残っている範囲から返す)
    expect(pm.read(id, 0)!.output).toBe('456789abcdefGHIJ');
    expect(pm.read(id, 18)!.output).toBe('IJ');
    // 末尾を超える sinceByte は空
    expect(pm.read(id, 999)!.output).toBe('');
  });

  it('存在しないidは read=undefined / kill=not-found', () => {
    const pm = new ProcessManager();
    expect(pm.read(999)).toBeUndefined();
    expect(pm.kill(999)).toBe('not-found');
  });

  it('killAll で実行中プロセスが全て止まる(セッションキャンセル・アプリ終了用)', async () => {
    const pm = new ProcessManager();
    const a = pm.start(`node -e "setInterval(() => {}, 1000)"`, process.cwd());
    const b = pm.start(`node -e "setInterval(() => {}, 1000)"`, process.cwd());
    expect(a.id).not.toBe(b.id);
    pm.killAll();
    await waitFor(() => pm.runningCount() === 0);
    expect(pm.read(a.id)?.running).toBe(false);
    expect(pm.read(b.id)?.running).toBe(false);
  });

  it('spawn 失敗はエラーとして出力に残り running=false になる', async () => {
    // shell 経由でも即失敗させるため、存在しない cwd を渡す
    const pm = new ProcessManager();
    const { id } = pm.start('echo x', '/no/such/dir/exists/never');
    await waitFor(() => pm.read(id)?.running === false);
    const snap = pm.read(id)!;
    expect(snap.exitCode === -1 || (snap.exitCode !== 0 && snap.exitCode !== null)).toBe(true);
  });

  it('Windows kill コマンドの組み立ては taskkill /pid <pid> /T /F(実行はWindows実機確認)', () => {
    expect(windowsKillArgs(1234)).toEqual({ cmd: 'taskkill', args: ['/pid', '1234', '/T', '/F'] });
  });
});
