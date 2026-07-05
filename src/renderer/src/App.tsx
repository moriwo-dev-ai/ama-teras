import { useEffect, useState } from 'react';
import { ApprovalDialog } from './components/Approval/ApprovalDialog';
import { ChatView } from './components/Chat/ChatView';
import { ToolDebugPanel } from './components/Debug/ToolDebugPanel';
import { SubAgentPanel } from './components/Agents/SubAgentPanel';
import { EvolutionPanel, PromotionDialog } from './components/Evolution/EvolutionPanel';
import { LeftPane } from './components/Layout/LeftPane';
import { RightPane } from './components/Layout/RightPane';
import { SidePane, useIsNarrow, usePaneState } from './components/Layout/SidePane';
import { PlanPanel } from './components/Plan/PlanPanel';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { useApprovalStore } from './stores/approval';
import { useChatStore } from './stores/chat';
import { useEvolutionStore } from './stores/evolution';
import { usePreviewStore } from './stores/preview';
import { useSubAgentStore } from './stores/subagents';

export default function App(): JSX.Element {
  const handleChatEvent = useChatStore((s) => s.handleEvent);
  const enqueueApproval = useApprovalStore((s) => s.enqueue);
  const resolveApprovalExternally = useApprovalStore((s) => s.resolveExternally);
  const handleEvolutionEvent = useEvolutionStore((s) => s.handleEvent);
  const handleSubAgentUpdate = useSubAgentStore((s) => s.handleUpdate);
  const [showDebug, setShowDebug] = useState(false);
  const [showEvolution, setShowEvolution] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showAgents, setShowAgents] = useState(false);
  // M15-1: 3ペイン(狭幅ではオーバーレイ。既定は狭幅時に折りたたみ)
  const narrow = useIsNarrow();
  const left = usePaneState('mycodex-pane-left', 240);
  const right = usePaneState('mycodex-pane-right', 320);
  // M15-3: プレビューを開いたら右ペインを自動で開く
  const previewOpen = usePreviewStore((s) => s.result !== null);
  const setRightCollapsed = right.setCollapsed;
  useEffect(() => {
    if (previewOpen) setRightCollapsed(false);
  }, [previewOpen, setRightCollapsed]);

  useEffect(() => window.api.onChatEvent(handleChatEvent), [handleChatEvent]);
  useEffect(() => window.api.onApprovalRequest(enqueueApproval), [enqueueApproval]);
  useEffect(
    () => window.api.onApprovalResolved((p) => resolveApprovalExternally(p.id)),
    [resolveApprovalExternally],
  );
  useEffect(() => window.api.onEvolutionEvent(handleEvolutionEvent), [handleEvolutionEvent]);
  useEffect(() => window.api.onSubAgentUpdate(handleSubAgentUpdate), [handleSubAgentUpdate]);

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
            className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            title="右ペイン(Ctrl+J)"
            onClick={right.toggle}
          >
            ◨
          </button>
          <button
            className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            onClick={() => setShowSettings(true)}
          >
            設定
          </button>
          <button
            className="rounded border border-emerald-800 px-2 py-0.5 text-xs text-emerald-300 hover:bg-zinc-800"
            onClick={() => setShowPlan((v) => !v)}
          >
            計画
          </button>
          <button
            className="rounded border border-sky-800 px-2 py-0.5 text-xs text-sky-300 hover:bg-zinc-800"
            onClick={() => setShowAgents((v) => !v)}
          >
            エージェント
          </button>
          <button
            className="rounded border border-purple-800 px-2 py-0.5 text-xs text-purple-300 hover:bg-zinc-800"
            onClick={() => setShowEvolution((v) => !v)}
          >
            進化
          </button>
          <button
            className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            onClick={() => setShowDebug((v) => !v)}
          >
            デバッグ
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
          {showPlan && <PlanPanel />}
          {showAgents && <SubAgentPanel />}
          {showEvolution && <EvolutionPanel />}
          {showDebug && <ToolDebugPanel />}
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
