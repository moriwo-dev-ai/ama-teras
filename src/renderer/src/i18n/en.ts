import type { MessageKey } from './ja';

/**
 * M100-1: English dictionary. `Record<MessageKey, string>` guarantees at the type level
 * that every key in ja.ts has an English counterpart (missing keys fail typecheck).
 */
export const en: Record<MessageKey, string> = {
  // App shell (App.tsx)
  'app.tagline': 'Self-evolving AI agent',
  'app.settings': 'Settings',
  'app.settingsTitle': 'Open settings (provider, API keys, scope, etc.)',
  'app.leftPane': 'Left pane (Ctrl+B)',
  'app.rightPane': 'Right pane (Ctrl+J)',
  'app.safeMode': '⚠ Safe mode: evolution {tag} kept crashing on restart, so evolution is disabled. To recover:',
  'app.safeModeClear': 'Clear (restart required)',
  'app.restarted': '✅ Evolution {tag} restart complete (now running the new code)',

  // Left pane (LeftPane.tsx)
  'left.newTask': '+ New task',
  'left.newTaskBusy': 'Start a new task without stopping the current run',
  'left.search': 'Search (title & content)… Ctrl+K',
  'left.noMatch': 'No matches',
  'left.noSessions': 'No sessions yet',
  'left.current': 'current',
  'left.newProject': 'New project in another folder',
  'left.running': 'Running',
  'left.untitled': '(untitled)',
  'left.rename': 'Rename',
  'left.delete': 'Delete',
  'left.renameFailed': 'Could not rename',
  'left.revealFolder': '📂 Show in folder',
  'left.opsEntryTitle': 'Operations (Project TAKAMA-gahara) — talk with the council, review approval batches',
  'left.tsukuyomiTitle': 'TUKU-yomi — what you said, and what it did',
  'left.justNow': 'just now',
  'left.minutesAgo': '{n}m ago',
  'left.hoursAgo': '{n}h ago',
  'left.daysAgo': '{n}d ago',

  // Chat (ChatView.tsx)
  'chat.readFailed': 'Failed to read',
  'chat.running': 'Running',
  'chat.silent': '⏳no output {n}s',
  'chat.silentTitle': 'Output has stalled but the run is still alive (not killed)',
  'chat.previewTitle': 'Preview {path} (right-click: show in folder)',
  'chat.toolResultImage': 'Tool result image',
  'chat.statusCallingLlm': 'Waiting for model',
  'chat.statusExecutingTool': 'Running tool',
  'chat.currentStatus': 'Current status: ',
  'chat.statusLabel': 'Status: ',
  'chat.autonomousOn': '🔓 Autonomous mode — running tools without approval (at your own risk)',
  'chat.autonomousOff': 'Turn OFF',
  'chat.emptyHint': 'Type an instruction to put the agent to work (register API keys in Settings)',
  'chat.queuedInstruction': '↩ Queued instruction (applied next turn)',
  'chat.openModelPolicy': 'Click to open model policy (band settings)',
  'chat.openModelSettings': 'Click to open model settings',
  'chat.openSettingsTab': '⚙ Open settings ({tab} tab)',
  'chat.tabModels': 'Models',
  'chat.tabBasic': 'Basic',
  'chat.planMode': 'Plan mode (present a plan first, no tools executed)',
  'chat.dropHint': 'Drag & drop / paste to attach images',
  'chat.attachedImage': 'Attached image',
  'chat.autonomousTurnOff': 'Turn autonomous mode OFF',
  'chat.autonomousTurnOn': 'Turn autonomous mode ON (auto-run without approval)',
  'chat.placeholderBusy': 'Type an extra instruction (works mid-run, applied next turn)',
  'chat.placeholder': 'Type an instruction (Enter to send / Shift+Enter for newline)',
  'chat.stop': 'Stop',

  // Approval dialog (ApprovalDialog.tsx)
  'approval.riskSafe': 'read',
  'approval.riskWrite': 'write',
  'approval.riskExec': 'exec',
  'approval.title': 'Approve tool execution:',
  'approval.queued': '(+{n} waiting)',
  'approval.origin': 'From:',
  'approval.sanctuaryTitle': '🛡 Change to a protected area (sanctuary)',
  'approval.sanctuaryBody':
    'This writes to files that guard the app itself — the approval system, evolution guard, or key material. Review the diff carefully (session-allow and auto-approve never pass this).',
  'approval.subAgent': '🤖 Request from sub-agent #{id} (parallel work via dispatch_agent)',
  'approval.mcp': '🔌 MCP: {server} — external MCP server tool (outside path-based scope checks)',
  'approval.fullPcTitle': '⚠ Operation outside the project (full-PC scope)',
  'approval.fullPcBody': 'This affects files outside the working directory. Approval is required every time.',
  'approval.diff': 'Changes:',
  'approval.deny': 'Deny',
  'approval.allowSession': 'Always allow this session',
  'approval.allowSessionLabeled': 'Always allow this session ({label})',
  'approval.allow': 'Allow',

  // Settings (language section in BasicSection.tsx)
  'settings.language': 'UI language / UI言語',
  'settings.languageAuto': 'Auto (follow OS) / 自動',
  'settings.languageHint': 'Applies immediately. Coverage is expanding screen by screen (main screens first).',
} as const;
