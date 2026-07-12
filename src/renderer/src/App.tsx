import { useEffect, useState } from 'react';
import { ApprovalDialog } from './components/Approval/ApprovalDialog';
import { IwatoApprovalDialog } from './components/Approval/IwatoApprovalDialog';
import { ChatView } from './components/Chat/ChatView';
import { PromotionDialog } from './components/Evolution/EvolutionPanel';
import { OpsThreadPanel } from './components/Operations/OpsThreadPanel';
import { LeftPane } from './components/Layout/LeftPane';
import { RevealMenu } from './components/Layout/RevealMenu';
import { RightPane } from './components/Layout/RightPane';
import { SidePane, useIsNarrow, usePaneState } from './components/Layout/SidePane';
import { UpdateBanner } from './components/Layout/UpdateBanner';
import { speak } from './components/Tsukuyomi/speak';
import { WatchIndicator } from './components/Tsukuyomi/WatchIndicator';
import { useTsukuyomiStore } from './stores/tsukuyomi';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { useApprovalStore } from './stores/approval';
import { useChatStore } from './stores/chat';
import { useOpsThreadStore } from './stores/opsThread';
import { useEvolutionStore } from './stores/evolution';
import { usePreviewStore } from './stores/preview';
import { useRightPaneStore } from './stores/rightPane';
import { useRunsStore } from './stores/runs';
import { useSubAgentStore } from './stores/subagents';

export default function App(): JSX.Element {
  const handleChatEvent = useChatStore((s) => s.handleEvent);
  const enqueueApproval = useApprovalStore((s) => s.enqueue);
  const resolveApprovalExternally = useApprovalStore((s) => s.resolveExternally);
  const handleEvolutionEvent = useEvolutionStore((s) => s.handleEvent);
  const handleSubAgentUpdate = useSubAgentStore((s) => s.handleUpdate);
  const [showSettings, setShowSettings] = useState(false);
  const opsThreadOpen = useOpsThreadStore((s) => s.open);
  // M30-2: エラーカード・モデルバッジ等からの「設定を開く」導線(開くタブ+再発火用nonce)
  const [settingsTab, setSettingsTab] = useState<'basic' | 'models' | 'quality' | 'connect' | 'memory'>('basic');
  const [settingsNonce, setSettingsNonce] = useState(0);
  useEffect(() => {
    const handler = (e: Event): void => {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      setSettingsTab(
        tab === 'models' || tab === 'quality' || tab === 'connect' || tab === 'memory' ? tab : 'basic',
      );
      setSettingsNonce((n) => n + 1);
      setShowSettings(true);
    };
    window.addEventListener('amateras:open-settings', handler);
    return () => window.removeEventListener('amateras:open-settings', handler);
  }, []);
  // M20: 起動時フラグ(セーフモード/進化再起動完了)のバナー
  const [flags, setFlags] = useState<{
    safeMode: boolean;
    safeModeInfo?: { tag: string; prevCommit: string };
    restartedFrom?: string;
  } | null>(null);
  const [restartNoticeClosed, setRestartNoticeClosed] = useState(false);
  // M42-2(TUKU-yomi): 月読の発話。OSの音声で実際に喋る(APIには何も送らない)。
  // 日本語の声が無い機体では main の System.Speech へフォールバックする
  useEffect(() => {
    return window.api.onTsukuyomiEvent((event) => {
      if (event.type === 'speak') {
        if (!speak(event.text)) void window.api.tsukuyomiSpeakFallback(event.text);
      }
      if (event.type === 'cho-changed') void useTsukuyomiStore.getState().refreshEntries();
      if (event.type === 'status') useTsukuyomiStore.setState({ status: event.status });
    });
  }, []);

  useEffect(() => {
    // ready-to-show後にrestartedFromが立つため少し遅らせて取得
    const t = setTimeout(() => {
      window.api.runtimeFlags().then(setFlags).catch(() => {});
    }, 1500);
    return () => clearTimeout(t);
  }, []);
  // M15-1: 3ペイン(狭幅ではオーバーレイ)
  const narrow = useIsNarrow();
  const left = usePaneState('amateras-pane-left', 240);
  const right = usePaneState('amateras-pane-right', 320);
  const openRequestCount = useRightPaneStore((s) => s.openRequestCount);
  // M15-3/4: プレビューを開く・タブを開く要求で右ペインの折りたたみを解除
  const previewOpen = usePreviewStore((s) => s.result !== null);
  const setRightCollapsed = right.setCollapsed;
  useEffect(() => {
    if (previewOpen) setRightCollapsed(false);
  }, [previewOpen, setRightCollapsed]);
  useEffect(() => {
    if (openRequestCount > 0) setRightCollapsed(false);
  }, [openRequestCount, setRightCollapsed]);

  useEffect(() => window.api.onChatEvent(handleChatEvent), [handleChatEvent]);
  useEffect(() => window.api.onApprovalRequest(enqueueApproval), [enqueueApproval]);
  useEffect(
    () => window.api.onApprovalResolved((p) => resolveApprovalExternally(p.id)),
    [resolveApprovalExternally],
  );
  useEffect(() => window.api.onEvolutionEvent(handleEvolutionEvent), [handleEvolutionEvent]);
  useEffect(() => window.api.onSubAgentUpdate(handleSubAgentUpdate), [handleSubAgentUpdate]);
  // M22: 実行中ラン一覧(左ペインの実行中インジケータ)
  const setRuns = useRunsStore((s) => s.setRuns);
  const refreshRuns = useRunsStore((s) => s.refresh);
  useEffect(() => {
    void refreshRuns();
  }, [refreshRuns]);
  useEffect(() => window.api.onRunsChanged(setRuns), [setRuns]);

  // M15-5: キーボードショートカット(Ctrl+B/J/K)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        left.toggle();
      } else if (key === 'j') {
        e.preventDefault();
        right.toggle();
      } else if (key === 'k') {
        e.preventDefault();
        left.setCollapsed(false);
        // 左ペイン描画後に検索へフォーカス
        setTimeout(() => document.querySelector<HTMLInputElement>('#session-search')?.focus(), 50);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [left, right]);

  return (
    <div className="flex h-screen flex-col">
      {/* M42-3(TUKU-yomi): 稼働中は必ず見える(鉄則5)。停止は常に1クリック */}
      <WatchIndicator />
      {/* M42-1: 新しい版のお知らせ(通知のみ。自動更新はしない) */}
      <UpdateBanner />
      {/* M20: セーフモード(進化再起動の連続クラッシュ検知)バナー */}
      {flags?.safeMode && (
        <div className="flex items-center justify-center gap-3 border-b border-red-700 bg-red-950 px-4 py-1.5 text-xs text-red-200">
          <span>
            ⚠ セーフモード: 進化 {flags.safeModeInfo?.tag} の再起動が連続失敗したため進化機能を停止中。
            復旧: <code className="rounded bg-zinc-900 px-1">git reset --hard {flags.safeModeInfo?.prevCommit.slice(0, 8)} && npm run build</code>
          </span>
          <button
            className="rounded border border-red-600 px-2 py-0.5 text-red-100 hover:bg-red-900"
            onClick={() => {
              void window.api.safeModeClear().then(() => setFlags((f) => (f ? { ...f, safeMode: false } : f)));
            }}
          >
            解除(要再起動)
          </button>
        </div>
      )}
      {flags?.restartedFrom && !restartNoticeClosed && (
        <div className="flex items-center justify-center gap-3 border-b border-emerald-800 bg-emerald-950/70 px-4 py-1 text-xs text-emerald-200">
          <span>✅ 進化 {flags.restartedFrom} の再起動が完了しました(新しいコードで稼働中)</span>
          <button className="text-emerald-300 hover:text-emerald-100" onClick={() => setRestartNoticeClosed(true)}>
            ✕
          </button>
        </div>
      )}
      <header className="flex items-center gap-2 border-b border-zinc-700 px-4 py-2">
        <button
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          title="左ペイン(Ctrl+B)"
          onClick={left.toggle}
        >
          ☰
        </button>
        <h1 className="text-sm font-semibold tracking-wide text-rose-700">AMA-teras</h1>
        <span className="text-xs text-zinc-400">自己進化型AIエージェント</span>
        <div className="ml-auto flex gap-2">
          <button
            className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            title="設定を開く(プロバイダ・APIキー・スコープ等)"
            onClick={() => setShowSettings(true)}
          >
            設定
          </button>
          <button
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            title="右ペイン(Ctrl+J)"
            onClick={right.toggle}
          >
            ◨
          </button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <SidePane
          side="left"
          width={left.state.width}
          collapsed={left.state.collapsed}
          narrow={narrow}
          onResize={left.setWidth}
          onClose={() => left.setCollapsed(true)}
        >
          <LeftPane />
        </SidePane>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* M33-4: ⛩運営スレッド(左ペインの常設エントリで開閉。通常チャットと混ぜない) */}
          {opsThreadOpen ? <OpsThreadPanel /> : <ChatView />}
        </main>
        <SidePane
          side="right"
          width={right.state.width}
          collapsed={right.state.collapsed}
          narrow={narrow}
          onResize={right.setWidth}
          onClose={() => right.setCollapsed(true)}
        >
          <RightPane />
        </SidePane>
      </div>
      {showSettings && (
        <SettingsPanel
          key={settingsNonce}
          initialTab={settingsTab}
          onClose={() => {
            setShowSettings(false);
            setSettingsTab('basic'); // 手動で開いたときは従来どおり基本タブから
          }}
        />
      )}
      <ApprovalDialog />
      <IwatoApprovalDialog />
      <PromotionDialog />
      <RevealMenu />
    </div>
  );
}
