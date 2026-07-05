import { useEffect, useState } from 'react';
import { ApprovalDialog } from './components/Approval/ApprovalDialog';
import { ChatView } from './components/Chat/ChatView';
import { PromotionDialog } from './components/Evolution/EvolutionPanel';
import { LeftPane } from './components/Layout/LeftPane';
import { RightPane } from './components/Layout/RightPane';
import { SidePane, useIsNarrow, usePaneState } from './components/Layout/SidePane';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { useApprovalStore } from './stores/approval';
import { useChatStore } from './stores/chat';
import { useEvolutionStore } from './stores/evolution';
import { usePreviewStore } from './stores/preview';
import { useRightPaneStore, type RightPaneTab } from './stores/rightPane';
import { useSubAgentStore } from './stores/subagents';

export default function App(): JSX.Element {
  const handleChatEvent = useChatStore((s) => s.handleEvent);
  const enqueueApproval = useApprovalStore((s) => s.enqueue);
  const resolveApprovalExternally = useApprovalStore((s) => s.resolveExternally);
  const handleEvolutionEvent = useEvolutionStore((s) => s.handleEvent);
  const handleSubAgentUpdate = useSubAgentStore((s) => s.handleUpdate);
  const [showSettings, setShowSettings] = useState(false);
  // M15-1: 3ペイン(狭幅ではオーバーレイ)
  const narrow = useIsNarrow();
  const left = usePaneState('mycodex-pane-left', 240);
  const right = usePaneState('mycodex-pane-right', 320);
  const openTab = useRightPaneStore((s) => s.openTab);
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

  const tabButton = (label: string, tab: RightPaneTab, cls: string): JSX.Element => (
    <button
      className={`rounded border px-2 py-0.5 text-xs hover:bg-zinc-800 ${cls}`}
      onClick={() => openTab(tab)}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center gap-2 border-b border-zinc-700 px-4 py-2">
        <button
          className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          title="左ペイン(Ctrl+B)"
          onClick={left.toggle}
        >
          ☰
        </button>
        <h1 className="text-sm font-semibold tracking-wide">MyCodex</h1>
        <span className="text-xs text-zinc-400">自己進化型コーディングエージェント</span>
        <div className="ml-auto flex gap-2">
          <button
            className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            onClick={() => setShowSettings(true)}
          >
            設定
          </button>
          {tabButton('計画', 'plan', 'border-emerald-800 text-emerald-300')}
          {tabButton('エージェント', 'agents', 'border-sky-800 text-sky-300')}
          {tabButton('進化', 'evolution', 'border-purple-800 text-purple-300')}
          {tabButton('デバッグ', 'debug', 'border-zinc-600 text-zinc-400')}
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
          <ChatView />
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
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      <ApprovalDialog />
      <PromotionDialog />
    </div>
  );
}
