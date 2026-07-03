# MyCodex アーキテクチャ設計

自己進化型・Codexライクなデスクトップエージェント。Electron + Vite + React 18 + TypeScript (strict)。

## 1. モジュール構成

```
src/
├── main/                      # Electron main process
│   ├── index.ts               # エントリ。ウィンドウ生成、IPC登録、スモークモード分岐
│   ├── ipc.ts                 # IPCハンドラ登録(型付きチャネル定義は shared/ipc.ts)
│   ├── agent/
│   │   ├── loop.ts            # エージェントループ本体(状態機械)
│   │   ├── session.ts         # セッション管理(履歴、キャンセル、max turns)
│   │   └── approval.ts        # ツール実行承認の待ち合わせ(renderer承認UIと連携)
│   ├── providers/
│   │   ├── types.ts           # LLMProvider 共通インターフェース(§4)
│   │   ├── anthropic.ts       # Anthropic実装(prompt caching必須)
│   │   └── openai.ts          # OpenAI実装(M6)
│   ├── tools/
│   │   ├── types.ts           # ToolPlugin インターフェース(§5)
│   │   ├── loader.ts          # プラグイン動的ロード/リロード(§5.2)
│   │   ├── registry.ts        # ロード済みツールの登録簿・実行ディスパッチ
│   │   └── plugins/           # 1ツール=1ファイル。進化ジョブが書き込める唯一のコード領域
│   │       ├── read_file.ts
│   │       ├── write_file.ts
│   │       ├── edit_file.ts
│   │       ├── list_dir.ts
│   │       ├── grep.ts
│   │       ├── bash.ts
│   │       └── request_capability.ts   # 自己進化のトリガー(進化マネージャへ委譲)
│   ├── evolution/             # 【保護領域】自己進化サブシステム(§6)
│   │   ├── manager.ts         # ジョブのライフサイクル管理
│   │   ├── worktree.ts        # git worktree 操作(B環境の作成/破棄)
│   │   ├── job.ts             # B内で子エージェントセッションを起動しツール生成
│   │   ├── gates.ts           # 検証ゲート(typecheck → vitest → smoke → 差分検査)
│   │   ├── promote.ts         # 昇格(merge → tag → ホットリロード)
│   │   └── supervisor.ts      # 昇格後の健全性チェックとロールバック
│   ├── secrets.ts             # APIキー保管(Electron safeStorage。平文保存禁止)
│   └── config.ts              # 設定(プロバイダ選択、自動承認モード等)の永続化
├── preload/
│   └── index.ts               # contextBridge。shared/ipc.ts の型に従うAPIのみ公開
├── renderer/                  # React UI
│   ├── index.html
│   └── src/
│       ├── App.tsx
│       ├── stores/            # zustand(chat / approval / evolution / settings)
│       ├── components/
│       │   ├── Chat/          # メッセージ一覧、入力欄、ストリーミング表示
│       │   ├── DiffView/      # write/edit 承認時の差分表示
│       │   ├── Approval/      # ツール実行承認ダイアログ(危険操作の警告表示)
│       │   ├── Evolution/     # 進化ジョブの進捗・昇格承認ダイアログ
│       │   └── Settings/      # APIキー、プロバイダ、自動承認設定
│       └── main.tsx
└── shared/                    # main/renderer 双方から import する型のみ(ロジック禁止)
    ├── ipc.ts                 # IPCチャネル名と payload 型の一覧(§3)
    └── types.ts               # ChatMessage, ToolCall, EvolutionJob など共通型
```

ビルドは electron-vite(main / preload / renderer の3ターゲット)。テストは vitest(`src/**/*.test.ts`)。

## 2. プロセスモデル

- **main**: エージェントループ、ツール実行、プロバイダ呼び出し、進化管理。Node API はここだけ。
- **renderer**: 表示と入力のみ。`window.api`(preload が公開)経由でしか main と話せない。
  `nodeIntegration: false` / `contextIsolation: true` / `sandbox: true`。
- **進化ジョブ**: main 内の子エージェントセッションとして実行(別プロセスにしない。
  ただし作業ディレクトリとツール書き込み許可を B worktree に限定)。
- **スモークテスト**: `MYCODEX_SMOKE=1 electron .` で BrowserWindow を開かず
  プラグインロード→指定ツールを1回実行→結果をJSONでstdoutへ→exit。進化ゲートが子プロセスとして起動する。

## 3. IPC設計

チャネル名と payload 型は `src/shared/ipc.ts` に一元定義。preload はこの型に従う関数だけを
`window.api` に生やす。renderer から `ipcRenderer` を直接触らない。

| チャネル | 方向 | 型(要約) |
|---|---|---|
| `chat:send` | R→M invoke | `(text: string) => { sessionId: string }` |
| `chat:cancel` | R→M invoke | `(sessionId) => void` |
| `chat:event` | M→R push | `AgentEvent`(§4.3。ストリーミングdelta、tool開始/終了、状態遷移) |
| `approval:request` | M→R push | `ApprovalRequest { id, toolName, input, diff?, warnings[] }` |
| `approval:respond` | R→M invoke | `(id, decision: 'allow'\|'deny'\|'allow-session') => void` |
| `evolution:event` | M→R push | `EvolutionEvent`(ジョブ状態遷移、ゲート結果、ログ) |
| `evolution:promote-respond` | R→M invoke | `(jobId, approved: boolean) => void` |
| `settings:get` / `settings:set` | R→M invoke | 設定の読み書き(APIキーは書き込みのみ、読み出しは有無のbooleanだけ) |

push系(M→R)は `webContents.send`。invoke系は `ipcMain.handle`。
全チャネルで payload を実行時にも検証(手書きガード。zodは入れない — 依存最小方針)。

## 4. プロバイダ抽象層

### 4.1 型定義(src/main/providers/types.ts)

```ts
/** プロバイダ非依存の共通メッセージ形式。Anthropic のブロック構造に寄せ、OpenAI側で変換する */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;   // JSON Schema (draft-07 サブセット)
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
  signal: AbortSignal;       // キャンセル必須
}

/** ストリーミングイベント。プロバイダ実装は各SDKのイベントをこれに正規化する */
export type ProviderEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_input_delta'; id: string; partialJson: string }
  | { type: 'message_done'; message: ChatMessage; stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } };

export interface LLMProvider {
  readonly id: 'anthropic' | 'openai';
  /** ストリーミング補完。イベントを順に yield し、最後に必ず message_done を返す */
  complete(req: CompletionRequest): AsyncIterable<ProviderEvent>;
}
```

### 4.2 実装上の規約

- **Anthropic**: `system` とツール定義(tools配列の最終要素)に `cache_control: { type: 'ephemeral' }` を必ず付与。
  会話履歴の最終ブロックにも付与し、ループ間でキャッシュを効かせる。
- **OpenAI**: tool_use/tool_result を function calling 形式に相互変換。ContentBlock列との対応は openai.ts に閉じ込める。
- プロバイダ切替は設定から。セッション途中の切替は新セッションからのみ有効。

### 4.3 エージェントループ状態遷移(src/main/agent/loop.ts)

```
 idle ──chat:send──▶ calling_llm ──tool_useなし──▶ done
                        │  ▲
                 tool_use│  │ tool_result投入
                        ▼  │
                 awaiting_approval ──deny──▶ (denied結果をtool_resultに) ─┐
                        │allow                                            │
                        ▼                                                  │
                  executing_tool ──────────────────────────────────────────┘
 どの状態からも: cancel ──▶ cancelled  /  例外 ──▶ error  /  turn数超過 ──▶ max_turns_reached
```

- 1 turn = LLM呼び出し1回。`maxTurns`(既定 30)超過で強制停止しユーザーに通知。
- キャンセルは AbortSignal をプロバイダと実行中ツールに伝播。
- 承認: 自動承認モードON時は read系ツールを常に許可、bash・書き込み系も設定に応じて許可
  (ただし進化の昇格承認は自動化対象外。§6.4)。

## 5. ツールプラグイン基盤

### 5.1 インターフェース(src/main/tools/types.ts)

```ts
export interface ToolContext {
  cwd: string;                       // セッションの作業ディレクトリ(進化ジョブではB worktree)
  writeAllowlist?: string[];         // 書き込み許可パス(進化ジョブで制限に使う)
  signal: AbortSignal;
  log: (line: string) => void;       // UIの進捗表示へ流れる
}

export interface ToolResult {
  content: string;                   // LLMへ返す文字列(長大なら先頭+末尾に切り詰め)
  isError?: boolean;
}

export interface ToolPlugin {
  name: string;                      // ファイル名と一致させる(read_file.ts → 'read_file')
  description: string;
  inputSchema: JsonSchema;
  /** 承認UIに出す危険度。'safe'は自動承認モードで無条件許可 */
  risk: 'safe' | 'write' | 'exec';
  /** 承認ダイアログに追加警告を出す条件(child_process/ネットワーク使用の自己申告) */
  warnings?: string[];
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

各プラグインは `export default { ... } satisfies ToolPlugin`。1ツール=1ファイル。

### 5.2 動的ロード(src/main/tools/loader.ts)

1. `src/main/tools/plugins/*.ts` を走査(パッケージ時は resources 内の plugins ディレクトリ)
2. esbuild(`transform` API)で TS→ESM に変換し、一時ファイル経由で `import(fileUrl + '?v=' + mtime)`
   — クエリ付きURLで import キャッシュをバイパスし、**再起動なしのリロード**を実現
3. default export を検証(name/inputSchema/execute の存在、name とファイル名の一致)。不正なら
   そのプラグインだけスキップしてUIにエラー表示(起動は継続)
4. `registry.reload()` は起動時と昇格直後に呼ばれる

ビルトインも進化産ツールも同じローダー・同じディレクトリ。**M2の時点からこの方式**にする
(静的importで作って後からローダーに置き換えるのは作り直しになるため禁止)。

### 5.3 承認フロー

- `risk: 'safe'`(read_file / list_dir / grep)以外は承認必須。
- write_file / edit_file は承認リクエストに diff を添付(DiffView が表示)。
- bash と、`warnings` に child_process / ネットワークを含むツールは、ダイアログに明示警告。
- 自動承認モード: 設定で risk レベルごとに許可を選べる。既定は safe のみ自動。

## 6. 自己進化サブシステム(src/main/evolution/ — 保護領域)

### 6.1 トリガー

エージェントが対応不能な要求に遭遇 → `request_capability(description, expectedIO)` を tool_use。
このツールの execute は EvolutionManager.enqueue() を呼び、ジョブIDを即座に tool_result で返す
(エージェントは「進化ジョブ N を開始しました」とユーザーに伝えて続行 or 終了)。

### 6.2 ジョブのライフサイクル

```
queued → preparing_worktree → generating → verifying → awaiting_promotion → promoting → done
                                   │            │             │                  │
                                   └────────────┴── failed ◀──┴──── rejected ◀───┘(却下/健全性NG時はrolled_back)
```

1. **B環境作成**(worktree.ts):
   `git worktree add ../mycodex-evolve/job-<N> -b evolve/job-<N>`(リポジトリ外の兄弟ディレクトリ)。
   A(稼働中のmain checkout)には一切触らない。B内で `npm ci` は行わず、`node_modules` は
   A からジャンクション(`mklink /J`)で共有(依存追加が必要なジョブは現状failさせる — 依存最小方針)。
2. **進化ジョブ**(job.ts): B を cwd とする子エージェントセッションを起動。
   - system prompt に「書き込み許可は `src/main/tools/plugins/**` と `src/main/tools/plugins/__tests__/**` のみ」を明記
   - ToolContext.writeAllowlist で機械的にも強制(write_file/edit_file が許可外パスを拒否)
   - 成果物: 新ツールプラグイン1ファイル + vitest ユニットテスト + スモーク用サンプル入力(JSON)
3. **検証ゲート**(gates.ts、全合格が昇格条件。B内で子プロセス実行):
   1. **差分検査(最初に実行)**: `git diff --name-only main...evolve/job-<N>` が許可パス
      (`src/main/tools/plugins/**`)のみか検査。許可外・保護領域(`src/main/evolution/**` 等)に
      1ファイルでも触れていたら **無条件fail**。これが保護領域の機械的な実装
      (プロンプトによる指示 + writeAllowlist + 差分検査の三重防御)。
      最初に置くのは、保護領域を書き換えた生成コードを後続ゲート(=コード実行を伴う)で
      走らせる前に落とすため
   2. `npm run typecheck`
   3. `npx vitest run`
   4. スモーク: B内で `npm run build` 後、`MYCODEX_SMOKE=1 electron . --tool <name> --input <sample.json>` を実行し exit 0 を確認
4. **昇格**(promote.ts):
   - renderer に承認ダイアログを push(ツール名、説明、全diff、警告[child_process/ネットワーク使用])
   - 承認 → A側で `git merge --no-ff evolve/job-<N>` → タグ `evolve/<N>` → worktree/ブランチ掃除
     → `registry.reload()` でホットリロード(プラグインのみの変更なら再起動不要)
   - コア変更を含む昇格(ユーザーが明示承認した場合のみ到達)はアプリ再起動をスケジュールし、
     supervisor が再起動後の健全性チェックを行う
5. **ロールバック**(supervisor.ts):
   - 健全性チェック = 起動成功 + プラグイン全ロード成功 + 昇格したツールのスモーク再実行
   - 失敗時: `git revert -m 1 <merge-commit>` で直前タグ状態へ自動復帰 → registry.reload() → UIに通知
     (revert方式なら履歴が残り、reset --hard 不要)

### 6.3 直列実行

進化ジョブは同時に1つ(キュー)。worktree の衝突と検証結果の混線を避ける。

### 6.4 昇格承認

デフォルトは必ずユーザー承認。設定 `evolution.autoPromote` で自動化可能にするが、
child_process / ネットワークアクセスを含むツールは autoPromote でも必ず手動承認。

## 7. シークレット管理

Electron `safeStorage`(WindowsではDPAPI)で暗号化し userData 配下に保存。
keytar は非メンテのため不採用(CLAUDE.md の「keytar等」の範囲内と判断。理由はPROGRESS.mdにも記録)。
renderer にはキーの有無(boolean)だけ渡す。平文がIPCを通ることは設定時の一方向のみ。

## 8. テスト戦略

- **ユニット(vitest)**: agent/loop(状態遷移・キャンセル・maxTurns)、providers(イベント正規化。SDKはモック)、
  tools/loader(ロード・検証・リロード)、evolution(gates の合否判定・差分検査、manager の状態遷移)
- **スモーク**: `MYCODEX_SMOKE=1` 起動パス自体が進化ゲートで常時使われるため実質E2E
- レンダラは M7 まで手動確認中心(zustand ストアのロジックのみユニットテスト)
