/**
 * M100-1: UI表示言語 — 日本語辞書(キーの正)。
 * キーは「画面.用途」のフラット形式。値の {name} プレースホルダは t() が置換する。
 * en.ts は `Record<MessageKey, string>` で型的に全キー実装を強制する。
 */
export const ja = {
  // アプリ全体(App.tsx)
  'app.tagline': '自己進化型AIエージェント',
  'app.settings': '設定',
  'app.settingsTitle': '設定を開く(プロバイダ・APIキー・スコープ等)',
  'app.leftPane': '左ペイン(Ctrl+B)',
  'app.rightPane': '右ペイン(Ctrl+J)',
  'app.safeMode': '⚠ セーフモード: 進化 {tag} の再起動が連続失敗したため進化機能を停止中。復旧:',
  'app.safeModeClear': '解除(要再起動)',
  'app.restarted': '✅ 進化 {tag} の再起動が完了しました(新しいコードで稼働中)',

  // 左ペイン(LeftPane.tsx)
  'left.newTask': '+ 新しいタスク',
  'left.newTaskBusy': '実行は止まらずに新しいタスクを開始する',
  'left.search': '検索(タイトル・本文)… Ctrl+K',
  'left.noMatch': '該当なし',
  'left.noSessions': 'セッションはまだ無い',
  'left.current': '現在',
  'left.newProject': '別フォルダで新規プロジェクト',
  'left.running': '実行中',
  'left.untitled': '(無題)',
  'left.rename': '名前変更',
  'left.delete': '削除',
  'left.renameFailed': '名前を変更できない',
  'left.revealFolder': '📂 フォルダで開く',
  'left.opsEntryTitle': '運営(Project TAKAMA-gahara)— 神議との会話・承認バッチ',
  'left.tsukuyomiTitle': 'TUKU-yomi — 話した内容と、月読がやったことの履歴',
  'left.justNow': 'たった今',
  'left.minutesAgo': '{n}分前',
  'left.hoursAgo': '{n}時間前',
  'left.daysAgo': '{n}日前',

  // チャット(ChatView.tsx)
  'chat.readFailed': '読み込み失敗',
  'chat.running': '実行中',
  'chat.silent': '⏳無応答{n}s',
  'chat.silentTitle': '出力が途絶えているが実行は継続中(killしない)',
  'chat.previewTitle': '{path} をプレビュー(右クリック: フォルダで開く)',
  'chat.toolResultImage': 'ツール結果画像',
  'chat.statusCallingLlm': 'モデル応答中',
  'chat.statusExecutingTool': 'ツール実行中',
  'chat.currentStatus': '現在の状況: ',
  'chat.statusLabel': '状態: ',
  'chat.autonomousOn': '🔓 自律モード有効 — ツールを承認なしで自動実行中(自己責任)',
  'chat.autonomousOff': 'OFFにする',
  'chat.emptyHint': '指示を入力するとエージェントが作業を開始します(APIキーは設定パネルから登録)',
  'chat.queuedInstruction': '↩ 追加指示(次のターンで反映)',
  'chat.openModelPolicy': 'クリックでモデル運用(帯設定)を開く',
  'chat.openModelSettings': 'クリックでモデル設定を開く',
  'chat.openSettingsTab': '⚙ 設定を開く({tab}タブ)',
  'chat.tabModels': 'モデル運用',
  'chat.tabBasic': '基本',
  'chat.planMode': 'プランモード(実装前に計画のみ提示・ツール不実行)',
  'chat.dropHint': '画像はドラッグ&ドロップ / ペーストで添付',
  'chat.attachedImage': '添付画像',
  'chat.autonomousTurnOff': '自律モードをOFFにする',
  'chat.autonomousTurnOn': '自律モード(承認なし自動実行)をONにする',
  'chat.placeholderBusy': '追加の指示を入力(実行中でも送れる・次のターンで反映)',
  'chat.placeholder': '指示を入力(Enterで送信 / Shift+Enterで改行)',
  'chat.stop': '停止',

  // 承認ダイアログ(ApprovalDialog.tsx)
  'approval.riskSafe': '読み取り',
  'approval.riskWrite': '書き込み',
  'approval.riskExec': '実行',
  'approval.title': 'ツール実行の承認:',
  'approval.queued': '(+{n} 件待ち)',
  'approval.origin': '出所:',
  'approval.sanctuaryTitle': '🛡 保護領域(聖域)への変更',
  'approval.sanctuaryBody':
    '承認機構・進化ガード・鍵素材など、本体の安全機構に関わるファイルへの書き込みです。diffを必ず確認してください(セッション許可・自動承認では通りません)',
  'approval.subAgent': '🤖 サブエージェント #{id} からの要求(dispatch_agent 経由の並列作業)',
  'approval.mcp': '🔌 MCP: {server} — 外部MCPサーバーのツール(パスベースのスコープ判定対象外)',
  'approval.fullPcTitle': '⚠ プロジェクト外の操作(PC全体スコープ)',
  'approval.fullPcBody': 'この操作は作業ディレクトリの外に影響する。毎回承認が必要。',
  'approval.diff': '変更内容:',
  'approval.deny': '拒否',
  'approval.allowSession': 'このセッションでは常に許可',
  'approval.allowSessionLabeled': 'このセッションでは常に許可({label})',
  'approval.allow': '許可',

  // 設定(BasicSection.tsx の言語まわり)
  'settings.language': 'UI言語 / Language',
  'settings.languageAuto': '自動(OSに合わせる)/ Auto',
  'settings.languageHint': '切替は即時反映。日本語/英語の対応は主要画面から段階的に拡大中',
} as const;

export type MessageKey = keyof typeof ja;
