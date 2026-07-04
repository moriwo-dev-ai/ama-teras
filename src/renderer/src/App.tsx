import { useEffect, useState } from 'react';
import { ApprovalDialog } from './components/Approval/ApprovalDialog';
import { ChatView } from './components/Chat/ChatView';
import { ToolDebugPanel } from './components/Debug/ToolDebugPanel';
import { SubAgentPanel } from './components/Agents/SubAgentPanel';
import { EvolutionPanel, PromotionDialog } from './components/Evolution/EvolutionPanel';
import { PlanPanel } from './components/Plan/PlanPanel';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { useApprovalStore } from './stores/approval';
import { useChatStore } from './stores/chat';
import { useEvolutionStore } from './stores/evolution';
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
        <h1 className="text-sm font-semibold tracking-wide">MyCodex</h1>
        <span className="text-xs text-zinc-400">自己進化型コーディングエージェント</span>
        <div className="ml-auto flex gap-2">
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
      <ChatView />
      {showPlan && <PlanPanel />}
      {showAgents && <SubAgentPanel />}
      {showEvolution && <EvolutionPanel />}
      {showDebug && <ToolDebugPanel />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      <ApprovalDialog />
      <PromotionDialog />
    </div>
  );
}
