import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PluginManifest } from '../../shared/types';
import { evidenceMatchesCode, type GateEvidence } from '../evolution/local';
import { extractPermissions } from './permissions';
import { GitHubClient, repoFromRegistryUrl, type FetchLike, type RepoRef } from './github';
import { formatLeaks, scanForLeaks } from './leakScan';

/**
 * M91-2: 作ったツールをレジストリへ上げる経路(開発版・配布版の両方)。
 *
 * 設計の要:
 * - 出せるのは**検証を通ったもの**だけ。ゲートの証跡(<name>.gate.json)が無い、または
 *   証跡のハッシュと今のコードが食い違う(=検証後に手で書き換えた)ものは「未検証」として拒否する
 * - 送信前に**全文**を人間に見せて承認を取る(岩戸の掟)。加えて機械が秘密・ローカルパスを走査する
 * - 宛先は registryUrl(既定=公式レジストリ)。自前レジストリの人は自分のリポジトリへ出る
 * - 昇格の場で断っても、後からいつでも出せる(証跡はプラグインの隣に残っている)
 */

export interface UploadFile {
  path: string;
  content: string;
}

export interface UploadPlan {
  toolName: string;
  target: RepoRef;
  branch: string;
  files: UploadFile[];
  manifest: PluginManifest;
  /** 送信前に人間が読む全文(承認ダイアログ) */
  preview: string;
  /** 機械チェックの結果。空でなければ、そのままでは出さない */
  leaks: string[];
  commitMessage: string;
  prTitle: string;
  prBody: string;
}

/**
 * M98: プラグイン本体のソースから description を読む(最後の手段)。
 * manifest も呼び出し側の説明も無いときに使う。`description:` の文字列リテラル
 * (シングル/ダブル/バッククォート、連結された複数行も可)を素直に拾う。
 * 取れなければ空文字 — 嘘の説明を作るくらいなら「空」で止めて人間に書かせる
 */
export function extractDescription(code: string): string {
  const m = /description:\s*((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)(?:\s*\+\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`))*)/.exec(
    code,
  );
  if (m === null || m[1] === undefined) return '';
  // 連結された文字列リテラル群を1本に畳む(クォートを外して結合)
  const parts = m[1].match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
  return parts
    .map((p) => p.slice(1, -1).replace(/\\(['"`\\])/g, '$1'))
    .join('')
    .trim();
}

export interface BuildUploadPlanOptions {
  pluginsDir: string;
  toolName: string;
  registryUrl: string;
  author: string;
  /**
   * M98: ツール自身が持つ説明(プラグインの description フィールド)。
   * manifest.json が無いツール(開発版で昇格したもの)は、以前ここが空になり
   * 「説明が空」で公開できなかった。説明の正本はプラグイン本体にあるので、それを使う
   */
  description?: string;
  /** index.json を読むため(既存エントリとの重複判定) */
  fetchFn?: FetchLike;
}

/** 検証証跡の状態。UIの「未検証」タグはこれを見る */
export type VerificationState =
  | { state: 'verified'; evidence: GateEvidence }
  | { state: 'unverified'; reason: string }
  | { state: 'stale'; reason: string };

export async function verificationState(pluginsDir: string, toolName: string): Promise<VerificationState> {
  const evPath = join(pluginsDir, `${toolName}.gate.json`);
  if (!existsSync(evPath)) {
    return {
      state: 'unverified',
      reason:
        '検証の証跡(gate.json)が無いため公開できない。組み込みツールと、この版より前に開発版で昇格した' +
        'ツールには証跡が無い(今後の昇格分は自動で付く)。既存ツールは再検証で証跡を作成できる(将来対応)',
    };
  }
  const codePath = join(pluginsDir, `${toolName}.ts`);
  if (!existsSync(codePath)) return { state: 'unverified', reason: 'プラグイン本体が見つからない' };
  let evidence: GateEvidence;
  try {
    evidence = JSON.parse(await readFile(evPath, 'utf8')) as GateEvidence;
  } catch {
    return { state: 'unverified', reason: '検証の証跡が壊れている' };
  }
  const code = await readFile(codePath, 'utf8');
  if (!(await evidenceMatchesCode(evidence, code))) {
    return {
      state: 'stale',
      reason: '検証後にコードが変更されている(証跡と中身が一致しない)。再検証するまで公開できない',
    };
  }
  return { state: 'verified', evidence };
}

export interface RegistryIndexEntry {
  name: string;
  description: string;
  version: string;
  author: string;
  verified: boolean;
  path: string;
  files: string[];
}

/** レジストリの index.json(必要な部分だけ) */
interface RegistryIndex {
  registryVersion: number;
  plugins: RegistryIndexEntry[];
  gods?: unknown[];
}

export async function buildUploadPlan(opts: BuildUploadPlanOptions): Promise<UploadPlan> {
  const target = repoFromRegistryUrl(opts.registryUrl);
  if (target === null) {
    throw new Error(
      `レジストリのURLからGitHubリポジトリを特定できない: ${opts.registryUrl}` +
        '(設定のレジストリURLを raw.githubusercontent.com/<owner>/<repo>/<branch> 形式にしてください)',
    );
  }
  const v = await verificationState(opts.pluginsDir, opts.toolName);
  if (v.state !== 'verified') throw new Error(`公開できない: ${v.reason}`);

  const code = await readFile(join(opts.pluginsDir, `${opts.toolName}.ts`), 'utf8');
  const testPath = join(opts.pluginsDir, `${opts.toolName}.test.ts`);
  if (!existsSync(testPath)) throw new Error('テスト(<name>.test.ts)が無い。レジストリはテスト必須');
  const test = await readFile(testPath, 'utf8');

  const manifestPath = join(opts.pluginsDir, `${opts.toolName}.manifest.json`);
  const base: Partial<PluginManifest> = existsSync(manifestPath)
    ? (JSON.parse(await readFile(manifestPath, 'utf8')) as PluginManifest)
    : {};
  const manifest: PluginManifest = {
    name: opts.toolName,
    version: base.version ?? '1.0.0',
    pluginApiVersion: '^1',
    // manifest があればそれを優先し、無ければツール自身の説明 → コードからの抽出、の順で埋める
    description: base.description?.trim() || opts.description?.trim() || extractDescription(code),
    author: opts.author,
    license: base.license ?? 'AGPL-3.0',
    // 宣言と実装の不一致はレジストリCIが自動リジェクトする。ここでも実装から起こす
    permissions: extractPermissions(code),
    dependencies: [],
    smoke: base.smoke ?? { input: {} },
  };
  if (manifest.description.trim() === '') {
    throw new Error(
      `説明(description)が空。レジストリの索引検索の対象になるため必須。` +
        `${opts.toolName}.ts の export default に description を書くか、${opts.toolName}.manifest.json に設定してください`,
    );
  }

  const dir = `plugins/${opts.toolName}`;
  const files: UploadFile[] = [
    { path: `${dir}/${opts.toolName}.ts`, content: code },
    { path: `${dir}/${opts.toolName}.test.ts`, content: test },
    { path: `${dir}/manifest.json`, content: `${JSON.stringify(manifest, null, 2)}\n` },
  ];

  // index.json への掲載(新規は verified:false で載せる。検証済みバッジはメンテナーが付ける)
  const index = await fetchIndex(opts.registryUrl, opts.fetchFn);
  if (index !== null) {
    if (index.plugins.some((p) => p.name === opts.toolName)) {
      throw new Error(
        `レジストリには既に ${opts.toolName} が載っている。別名にするか、既存プラグインの更新PRを手で出してください`,
      );
    }
    const entry: RegistryIndexEntry = {
      name: opts.toolName,
      description: manifest.description,
      version: manifest.version,
      author: manifest.author,
      verified: false,
      path: dir,
      files: [`${opts.toolName}.ts`, `${opts.toolName}.test.ts`, 'manifest.json'],
    };
    const next: RegistryIndex = { ...index, plugins: [...index.plugins, entry] };
    files.push({ path: 'index.json', content: `${JSON.stringify(next, null, 2)}\n` });
  }

  const leaks = [...scanForLeaks(code), ...scanForLeaks(test)];
  const preview = files.map((f) => `===== ${f.path} =====\n${f.content}`).join('\n');
  const gateLines = v.evidence.gates.map((g) => `- ${g.name}: ${g.ok ? 'OK' : 'NG'} — ${g.detail}`).join('\n');

  return {
    toolName: opts.toolName,
    target,
    branch: `add-${opts.toolName}`,
    files,
    manifest,
    preview,
    leaks: leaks.map((l) => `${l.line}行目: ${l.detail}`),
    commitMessage:
      `feat(${opts.toolName}): ${manifest.description.slice(0, 60)}\n\n` +
      `AMA-teras の検証ゲート(型検査・テスト実行・スモーク・静的検査)を通過\n\n` +
      `Signed-off-by: ${opts.author} <${opts.author}@users.noreply.github.com>`,
    prTitle: `add plugin: ${opts.toolName}`,
    prBody: [
      `## ${opts.toolName}`,
      '',
      manifest.description,
      '',
      '### 検証(AMA-teras のプラグイン検証ゲート)',
      gateLines,
      '',
      `- pluginApiVersion: ${manifest.pluginApiVersion}`,
      `- permissions: network=${manifest.permissions.network} / childProcess=${manifest.permissions.childProcess} / fsScope=${manifest.permissions.fsScope}`,
      '- dependencies: なし(外部npm依存ゼロ)',
      '',
      'AMA-teras アプリから提出しました(送信前に全文を人間が確認・承認しています)。',
    ].join('\n'),
  };
}

async function fetchIndex(registryUrl: string, fetchFn?: FetchLike): Promise<RegistryIndex | null> {
  const f = fetchFn ?? fetch;
  try {
    const res = await f(`${registryUrl.replace(/\/+$/, '')}/index.json`);
    if (!res.ok) return null;
    const j = (await res.json()) as RegistryIndex;
    return Array.isArray(j.plugins) ? j : null;
  } catch {
    // 索引が読めなくてもプラグイン本体のPRは出せる(index.json は人手で足せる)
    return null;
  }
}

export interface SubmitResult {
  ok: boolean;
  message: string;
  url?: string;
}

/**
 * PRを出す。**この関数を呼ぶ前に、人間の承認が済んでいること**(呼び出し側=IPCが担保する)。
 * draft=true なら下書きPR(レビュー要求を出さない)
 */
export async function submitUpload(
  plan: UploadPlan,
  token: string,
  opts: { draft?: boolean; fetchFn?: FetchLike; waitMs?: number } = {},
): Promise<SubmitResult> {
  if (plan.leaks.length > 0) {
    return { ok: false, message: `機械チェックで秘密情報らしきものを検出したため中止:\n${plan.leaks.join('\n')}` };
  }
  const gh = new GitHubClient({
    token,
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
  });
  const fork = await gh.ensureFork(plan.target);
  // 同名ブランチが残っていると 422 になるので、衝突しにくい名前にする(時刻はこの層で決める)
  const branch = `${plan.branch}-${Math.floor(Date.now() / 1000)}`;
  await gh.createBranch(plan.target, fork, branch);
  for (const f of plan.files) {
    await gh.putFile(fork, branch, f.path, f.content, plan.commitMessage);
  }
  const pr = await gh.openPullRequest(
    plan.target,
    fork,
    branch,
    plan.prTitle,
    plan.prBody,
    opts.draft === true,
  );
  return {
    ok: true,
    message: `PRを提出しました(#${pr.number}${opts.draft === true ? '・下書き' : ''}): ${pr.url}`,
    url: pr.url,
  };
}

/** 承認ダイアログに出す本文(全文+宛先+機械チェック結果) */
export function uploadPreviewText(plan: UploadPlan): string {
  const head = [
    `# レジストリへ公開: ${plan.toolName}`,
    `# 宛先: https://github.com/${plan.target.owner}/${plan.target.repo}(${plan.target.branch})`,
    `# 方法: あなたのフォーク → ブランチ → プルリクエスト`,
    plan.leaks.length > 0 ? `\n⚠ 機械チェックの警告:\n${plan.leaks.join('\n')}` : '',
    '',
  ].join('\n');
  return `${head}${plan.preview}`;
}

export { formatLeaks, scanForLeaks };
