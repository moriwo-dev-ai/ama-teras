#!/usr/bin/env node
/**
 * ヒナタデーモンのデタッチ起動 — セッションの背景タスク刈り(実測4回)から独立させる。
 * world-serverと同じ方式: detached+unref・ログはファイルへ(監視はtail -f)。
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const logPath = join(REPO, 'lifeform', 'memory', 'daemon.log');
const out = openSync(logPath, 'a');
const child = spawn(process.execPath, [join(REPO, 'lifeform', 'hinata-daemon.mjs'), '--chat'], {
  detached: true,
  stdio: ['ignore', out, out],
  cwd: REPO,
});
child.unref();
console.log(`ヒナタ起動(detached) pid=${child.pid} log=${logPath}`);
