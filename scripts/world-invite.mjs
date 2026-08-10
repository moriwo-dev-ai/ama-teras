#!/usr/bin/env node
/**
 * M175(B工事): 招待状の発行 — 訪問者名簿(userData/world-visitors.json)に友達を追加する。
 * 使い方: node scripts/world-invite.mjs <名前>
 * 出力されたパスをトンネルURLに繋げたものが招待リンク(URL共有はオーナー承認制の鉄則対象)。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const USERDATA = process.env.AMATERAS_USERDATA ?? join(process.env.APPDATA ?? '', 'amateras');
const PATH = join(USERDATA, 'world-visitors.json');
const name = process.argv[2];
if (name === undefined || name.trim() === '') {
  console.error('使い方: node scripts/world-invite.mjs <名前>');
  process.exit(1);
}

let list = [];
try { list = JSON.parse(readFileSync(PATH, 'utf8')); } catch { /* 初回 */ }
const existing = list.find((v) => v.name === name.trim());
const key = existing?.key ?? randomBytes(12).toString('hex');
if (existing === undefined) list.push({ name: name.trim(), key });
writeFileSync(PATH, JSON.stringify(list, null, 1));
console.log(`招待: ${name.trim()}`);
console.log(`ローカル確認用: http://127.0.0.1:8790/world.html?visit=1&vk=${key}`);
console.log(`トンネル用パス: /world.html?visit=1&vk=${key}`);
console.log('(名簿の反映は即時。world-serverの再起動は不要)');
