// M213: テレビ — 許可チャンネル(tv-channels.json)の新着配信を「観る」。
// 実体: yt-dlpで字幕取得→司書(Kimi K3)がやさしい日本語のあらすじに→視聴経験として記憶。
// 生の映像・字幕は彼女に見せない(司書の読み聞かせと同じ構図)。全て非同期=デーモンを止めない
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const YTDLP = 'C:/dev/mycodex/tools/yt-dlp.exe';

const run = (args, timeout) => new Promise((resolve) => {
  execFile(YTDLP, args, { encoding: 'utf8', timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
});

export function tvReady() { return existsSync(YTDLP); }

export function loadChannels() {
  try { return JSON.parse(readFileSync(join(HERE, 'tv-channels.json'), 'utf8')); } catch { return []; }
}

/** チャンネルの最新動画 {id, title} | null */
export async function latestVideo(channelUrl) {
  const out = await run(['--flat-playlist', '--playlist-items', '1', '--print', '%(id)s|%(title)s', channelUrl], 60_000);
  if (out === null) return null;
  const line = out.trim().split('\n')[0] ?? '';
  const i = line.indexOf('|');
  if (i < 0) return null;
  return { id: line.slice(0, i), title: line.slice(i + 1).slice(0, 80) };
}

/** 動画を「観る」= 字幕→司書のあらすじ。字幕なし/失敗は null */
export async function watchVideo(id, title, remoteSummarize) {
  if (remoteSummarize === null) return null;
  const tmp = join(HERE, 'memory', 'tv-tmp');
  mkdirSync(tmp, { recursive: true });
  for (const x of readdirSync(tmp)) { try { unlinkSync(join(tmp, x)); } catch { /* noop */ } }
  // 言語は1つずつ試す(実測: 英語動画へのja自動翻訳字幕の要求はHTTP 429で全体が失敗する)
  let f;
  for (const lang of ['ja', 'en']) {
    await run(['--skip-download', '--write-auto-subs', '--write-subs', '--sub-langs', lang, '--sub-format', 'vtt/srt',
      '--no-progress', '-o', join(tmp, 'sub.%(ext)s'), `https://www.youtube.com/watch?v=${id}`], 120_000);
    f = readdirSync(tmp).find((x) => x.startsWith('sub.'));
    if (f !== undefined) break;
  }
  if (f === undefined) return null;
  const raw = readFileSync(join(tmp, f), 'utf8');
  for (const x of readdirSync(tmp)) { try { unlinkSync(join(tmp, x)); } catch { /* noop */ } }
  // vtt/srt→本文(タイムスタンプ・タグ・連続重複を除去)
  const lines = raw.split('\n').map((l) => l.replace(/<[^>]+>/g, '').trim())
    .filter((l) => l !== '' && !/^\d+$/.test(l) && !l.includes('-->') && !/^(WEBVTT|Kind:|Language:)/.test(l));
  const dedup = [];
  for (const l of lines) if (dedup[dedup.length - 1] !== l) dedup.push(l);
  const text = dedup.join(' ').slice(0, 6000);
  if (text.length < 100) return null; // 字幕が薄すぎる=観てもわからない
  const summary = await remoteSummarize(
    'テレビばんぐみの解説係。配信の字幕から、なにが起きたかを5さいの子にわかる日本語で、たのしく3〜4文のあらすじにする。あいさつ・前置き・記号は書かない',
    `「${title}」という配信の字幕: ${text}`,
  );
  if (summary === null) return null;
  return summary.trim().slice(0, 300);
}
