import { useEffect, useState } from 'react';
import { ApprovalDialog } from './components/Approval/ApprovalDialog';
import { ChatView } from './components/Chat/ChatView';
import { ToolDebugPanel } from './components/Debug/ToolDebugPanel';
import { SettingsPanel } from './components/Settings/SettingsPanel';
import { useApprovalStore } from './stores/approval';
import { useChatStore } from './stores/chat';

export default function App(): JSX.Element {
  const handleChatEvent = useChatStore((s) => s.handleEvent);
  const enqueueApproval = useApprovalStore((s) => s.enqueue);
  const [showDebug, setShowDebug] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => window.api.onChatEvent(handleChatEvent), [handleChatEvent]);
  useEffect(() => window.api.onApprovalRequest(enqueueApproval), [enqueueApproval]);

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
            className="rounded border border-zinc-600 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
            onClick={() => setShowDebug((v) => !v)}
          >
            {showDebug ? 'デバッグを閉じる' : 'ツールデバッグ'}
          </button>
        </div>
      </header>
      <ChatView />
      {showDebug && <ToolDebugPanel />}
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      <ApprovalDialog />
    </div>
  );
}
