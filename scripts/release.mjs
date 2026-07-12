#!/usr/bin/env node
// リリース手順を1本のスクリプトに固定する(人間もエージェントも間違えないように)。
//
// なぜ必要か: v1.1.0 のリリースで、実際に「インストーラの添付を忘れる」事故が起きた。
// 更新バナーは出るのに落とすものが無い、という最悪の壊れ方をする。手順は多く、順番も効く
// (version を上げる前にビルドすると、中身が古い版のインストーラができる)。
// 覚えておく作業は機械にやらせる。
//
// 使い方:
//   node scripts/release.mjs --minor --notes-file notes.md          # 下書きまで(既定)
//   node scripts/release.mjs --version v1.2.3 --notes-file notes.md --publish
//   node scripts/release.mjs --minor --notes-file notes.md --dry-run # 何をするか見るだけ
//
// 既定では**下書き**まで。公開(= 全利用者に更新通知が飛ぶ)は --publish を明示したときだけ。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY = has('--dry-run');
const PUBLISH = has('--publish');
const REPO = valueOf('--repo') ?? 'moriwo-dev-ai/ama-teras';
const NOTES_FILE = valueOf('--notes-file');
const TITLE = valueOf('--title');

const GH_CANDIDATES = ['C:/Program Files/GitHub CLI/gh.exe', 'gh'];
const gh = GH_CANDIDATES.find((p) => p === 'gh' || existsSync(p));

function run(cmd, cmdArgs, opts = {}) {
  if (DRY) {
    console.log(`[dry-run] ${cmd} ${cmdArgs.join(' ')}`);
    return '';
  }
  return execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: opts.quiet ? 'pipe' : 'pipe', ...opts });
}
function fail(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
function step(n, msg) {
  console.log(`\n[${n}] ${msg}`);
}

// ---- 0. 前提チェック(ここで落とすのが一番安い) ----
if (gh === undefined) fail('gh(GitHub CLI)が見つからない');
if (NOTES_FILE === undefined || !existsSync(NOTES_FILE)) {
  fail('--notes-file <path> でリリースノート本文(Markdown)を渡すこと');
}

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty !== '') fail(`作業ツリーが汚れている(コミットしてから実行する):\n${dirty}`);

const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (branch !== 'main' && !has('--allow-branch')) fail(`main 以外のブランチ(${branch})。意図的なら --allow-branch`);

// ---- 1. 次のバージョンを決める ----
step(1, '次のバージョンを決める');
const pkgPath = join(ROOT, 'package.json');
const pkgText = readFileSync(pkgPath, 'utf8');
const current = /"version"\s*:\s*"([^"]+)"/.exec(pkgText)?.[1];
if (current === undefined) fail('package.json の version が読めない');

let latestTag = null;
try {
  const out = execFileSync(gh, ['release', 'view', '-R', REPO, '--json', 'tagName'], { encoding: 'utf8' });
  latestTag = JSON.parse(out).tagName ?? null;
} catch {
  console.log('  (公開済みリリースなし = 初回)');
}

const explicit = valueOf('--version');
const bump = has('--major') ? 'major' : has('--minor') ? 'minor' : has('--patch') ? 'patch' : null;
if (explicit === undefined && bump === null) fail('--patch / --minor / --major / --version vX.Y.Z のいずれかを指定する');

function nextFrom(tag, kind) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((tag ?? '').trim());
  if (m === null) return null;
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const n = kind === 'major' ? [maj + 1, 0, 0] : kind === 'minor' ? [maj, min + 1, 0] : [maj, min, pat + 1];
  return n.join('.');
}

// 基準は「公開済みの最新リリース」。無ければ package.json の現在値をそのまま初回リリースに使う
const version = explicit !== undefined ? explicit.replace(/^v/, '') : (nextFrom(latestTag, bump) ?? current);
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`不正なバージョン: ${version}`);
const tag = `v${version}`;
console.log(`  現在: package.json=${current} / 最新リリース=${latestTag ?? '(なし)'} → 今回: ${tag}`);

// 同じタグのリリースが既にあるなら止める(上書き事故の防止)
try {
  execFileSync(gh, ['release', 'view', tag, '-R', REPO, '--json', 'tagName'], { encoding: 'utf8', stdio: 'pipe' });
  if (!has('--force')) fail(`${tag} のリリースは既に存在する(上書きするなら --force)`);
} catch (e) {
  if (String(e.message).includes('既に存在')) throw e;
}

// ---- 2. package.json を上げてコミット・push(ビルドより先。順番が効く) ----
step(2, `package.json を ${current} → ${version} にしてコミット・push`);
if (current !== version) {
  if (!DRY) writeFileSync(pkgPath, pkgText.replace(/("version"\s*:\s*")([^"]+)(")/, `$1${version}$3`), 'utf8');
  run('git', ['add', 'package.json']); // 明示ステージング(他の変更を巻き込まない)
  run('git', ['commit', '-m', `chore: bump version to ${version}`]);
  run('git', ['push', 'origin', branch]);
} else {
  console.log('  すでに同じ版(変更なし)');
}

// ---- 3. 検証(壊れたものを配らない) ----
step(3, 'typecheck とテスト');
run('npm', ['run', 'typecheck'], { shell: true });
run('npx', ['vitest', 'run', '--silent'], { shell: true });

// ---- 4. インストーラをビルド(ここを忘れると「落とすものが無い更新通知」になる) ----
step(4, 'インストーラをビルド(npm run dist)');
run('npm', ['run', 'dist'], { shell: true });

const installer = join(ROOT, 'release', `AMA-teras Setup ${version}.exe`);
if (!DRY && !existsSync(installer)) fail(`インストーラが見つからない: ${installer}`);
console.log(`  ✓ ${installer}`);

// ---- 5. 下書きリリースを作ってインストーラを添付 ----
step(5, `${tag} の下書きリリースを作成し、インストーラを添付`);
const title = TITLE ?? `AMA-teras ${tag}`;
run(gh, ['release', 'create', tag, '-R', REPO, '--draft', '--title', title, '--notes-file', NOTES_FILE]);
run(gh, ['release', 'upload', tag, installer, '-R', REPO, '--clobber']);

// ---- 6. 添付されたことを実際に確かめる(思い込みで終わらせない) ----
step(6, '添付の確認');
if (!DRY) {
  const view = JSON.parse(
    execFileSync(gh, ['release', 'view', tag, '-R', REPO, '--json', 'assets,isDraft'], { encoding: 'utf8' }),
  );
  const names = (view.assets ?? []).map((a) => a.name);
  if (!names.some((n) => n.includes(version))) fail(`インストーラが添付されていない(assets: ${names.join(',') || 'なし'})`);
  console.log(`  ✓ draft=${view.isDraft} / assets=${names.join(', ')}`);
}

// ---- 7. 公開(明示したときだけ。押した瞬間に全利用者へ更新通知が飛ぶ) ----
if (PUBLISH) {
  step(7, '公開(全利用者のアプリに更新バナーが出る)');
  run(gh, ['release', 'edit', tag, '-R', REPO, '--draft=false']);
  console.log(`  ✓ 公開した: https://github.com/${REPO}/releases/tag/${tag}`);
} else {
  console.log(`\n✓ 下書きまで完了。内容を確認して公開してください:`);
  console.log(`  https://github.com/${REPO}/releases`);
  console.log(`  (このスクリプトに --publish を付ければ公開まで自動)`);
}
