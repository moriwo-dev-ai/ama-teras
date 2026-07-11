import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, type AmaterasApi } from '../shared/ipc';
import type {
  AgentEvent,
  ApprovalRequestPayload,
  ApprovalResolvedPayload,
  AutonomousStatePayload,
  EvolutionEvent,
  IwatoRequestPayload,
  RunInfo,
  SubAgentUpdate,
} from '../shared/types';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_e: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: AmaterasApi = {
  chatSend: (text, mode, images) => ipcRenderer.invoke(IpcChannels.chatSend, text, mode, images),
  chatCancel: (sessionId) => ipcRenderer.invoke(IpcChannels.chatCancel, sessionId),
  onChatEvent: (listener) => subscribe<AgentEvent>(IpcChannels.chatEvent, listener),

  onApprovalRequest: (listener) =>
    subscribe<ApprovalRequestPayload>(IpcChannels.approvalRequest, listener),
  approvalRespond: (id, decision) => ipcRenderer.invoke(IpcChannels.approvalRespond, id, decision),
  onApprovalResolved: (listener) =>
    subscribe<ApprovalResolvedPayload>(IpcChannels.approvalResolved, listener),

  toolsList: () => ipcRenderer.invoke(IpcChannels.toolsList),
  toolsExecute: (name, inputJson) => ipcRenderer.invoke(IpcChannels.toolsExecute, name, inputJson),
  toolsReload: () => ipcRenderer.invoke(IpcChannels.toolsReload),

  settingsGet: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  settingsSet: (config) => ipcRenderer.invoke(IpcChannels.settingsSet, config),
  pickWorkspace: () => ipcRenderer.invoke(IpcChannels.workspacePick),
  memoryGet: () => ipcRenderer.invoke(IpcChannels.memoryGet),
  memorySet: (content) => ipcRenderer.invoke(IpcChannels.memorySet, content),
  userMemoryGet: () => ipcRenderer.invoke(IpcChannels.userMemoryGet),
  userMemorySet: (content) => ipcRenderer.invoke(IpcChannels.userMemorySet, content),

  secretsSet: (provider, apiKey) => ipcRenderer.invoke(IpcChannels.secretsSet, provider, apiKey),
  secretsStatus: () => ipcRenderer.invoke(IpcChannels.secretsStatus),
  connectionTest: () => ipcRenderer.invoke(IpcChannels.connectionTest),

  onEvolutionEvent: (listener) => subscribe<EvolutionEvent>(IpcChannels.evolutionEvent, listener),
  evolutionPromoteRespond: (jobId, approved) =>
    ipcRenderer.invoke(IpcChannels.evolutionPromoteRespond, jobId, approved),
  evolutionEnqueue: (description, expectedIo, scope) =>
    ipcRenderer.invoke(IpcChannels.evolutionEnqueue, description, expectedIo, scope),
  evolutionList: () => ipcRenderer.invoke(IpcChannels.evolutionList),
  evolutionCancel: (jobId) => ipcRenderer.invoke(IpcChannels.evolutionCancel, jobId),
  pluginsExport: (toolName) => ipcRenderer.invoke(IpcChannels.pluginsExport, toolName),
  pluginsImport: () => ipcRenderer.invoke(IpcChannels.pluginsImport),
  conversationMoveWorkspace: (newWorkspace) =>
    ipcRenderer.invoke(IpcChannels.conversationMoveWorkspace, newWorkspace),

  checkpointList: () => ipcRenderer.invoke(IpcChannels.checkpointList),
  checkpointRestore: (sha) => ipcRenderer.invoke(IpcChannels.checkpointRestore, sha),

  sessionsList: () => ipcRenderer.invoke(IpcChannels.sessionsList),
  sessionsLoad: (id) => ipcRenderer.invoke(IpcChannels.sessionsLoad, id),
  sessionsDelete: (id) => ipcRenderer.invoke(IpcChannels.sessionsDelete, id),
  sessionsNew: () => ipcRenderer.invoke(IpcChannels.sessionsNew),
  sessionsSearch: (query) => ipcRenderer.invoke(IpcChannels.sessionsSearch, query),
  sessionsRename: (id, title) => ipcRenderer.invoke(IpcChannels.sessionsRename, id, title),

  filePreview: (path) => ipcRenderer.invoke(IpcChannels.filePreview, path),
  fileReveal: (path) => ipcRenderer.invoke(IpcChannels.fileReveal, path),
  workspaceGitStatus: () => ipcRenderer.invoke(IpcChannels.workspaceGitStatus),

  planGet: () => ipcRenderer.invoke(IpcChannels.planGet),

  onSubAgentUpdate: (listener) => subscribe<SubAgentUpdate>(IpcChannels.subAgentUpdate, listener),

  mcpStatus: () => ipcRenderer.invoke(IpcChannels.mcpStatus),
  mcpSetConfig: (config) => ipcRenderer.invoke(IpcChannels.mcpSetConfig, config),

  remoteStatus: () => ipcRenderer.invoke(IpcChannels.remoteStatus),
  remoteSetEnabled: (enabled, port) =>
    ipcRenderer.invoke(IpcChannels.remoteSetEnabled, enabled, port),
  remoteSetHost: (host) => ipcRenderer.invoke(IpcChannels.remoteSetHost, host),
  remoteRegenerateToken: () => ipcRenderer.invoke(IpcChannels.remoteRegenerateToken),

  autonomousGet: () => ipcRenderer.invoke(IpcChannels.autonomousGet),
  autonomousSet: (on, registryScope) => ipcRenderer.invoke(IpcChannels.autonomousSet, on, registryScope),
  inventoryList: () => ipcRenderer.invoke(IpcChannels.inventoryList),
  inventoryResolve: (jobId, keep) => ipcRenderer.invoke(IpcChannels.inventoryResolve, jobId, keep),
  onAutonomousChanged: (listener) =>
    subscribe<AutonomousStatePayload>(IpcChannels.autonomousChanged, listener),

  runsList: () => ipcRenderer.invoke(IpcChannels.runsList),
  onRunsChanged: (listener) => subscribe<RunInfo[]>(IpcChannels.runsChanged, listener),

  usageGet: () => ipcRenderer.invoke(IpcChannels.usageGet),
  openBillingPage: (provider) => ipcRenderer.invoke(IpcChannels.openBillingPage, provider),

  runtimeFlags: () => ipcRenderer.invoke(IpcChannels.runtimeFlags),
  safeModeClear: () => ipcRenderer.invoke(IpcChannels.safeModeClear),

  evolutionHistory: () => ipcRenderer.invoke(IpcChannels.evolutionHistory),
  evolutionRollbackLast: () => ipcRenderer.invoke(IpcChannels.evolutionRollbackLast),
  evolutionCapabilities: () => ipcRenderer.invoke(IpcChannels.evolutionCapabilities),

  // M32: 運営(Project TAKAMA-gahara)。オーナーモードOFF時はmain側が空/nullを返す
  operationsStatus: () => ipcRenderer.invoke(IpcChannels.operationsStatus),
  operationsSnapshot: () => ipcRenderer.invoke(IpcChannels.operationsSnapshot),
  operationsHistory: (limit) => ipcRenderer.invoke(IpcChannels.operationsHistory, limit),
  operationsWeeklyReport: () => ipcRenderer.invoke(IpcChannels.operationsWeeklyReport),
  operationsDraftsGenerate: () => ipcRenderer.invoke(IpcChannels.operationsDraftsGenerate),
  operationsDraftsList: () => ipcRenderer.invoke(IpcChannels.operationsDraftsList),
  operationsDraftUpdate: (id, patch) => ipcRenderer.invoke(IpcChannels.operationsDraftUpdate, id, patch),
  operationsDraftRelease: (draftId, repo, tag) =>
    ipcRenderer.invoke(IpcChannels.operationsDraftRelease, draftId, repo, tag),
  operationsDraftZennArticle: (draftId) =>
    ipcRenderer.invoke(IpcChannels.operationsDraftZennArticle, draftId),
  operationsStrategyBoard: () => ipcRenderer.invoke(IpcChannels.operationsStrategyBoard),
  operationsDiscoverySearch: (keywords) =>
    ipcRenderer.invoke(IpcChannels.operationsDiscoverySearch, keywords),
  operationsCandidateAnalyze: (pastedText, source) =>
    ipcRenderer.invoke(IpcChannels.operationsCandidateAnalyze, pastedText, source),
  operationsCandidatesList: () => ipcRenderer.invoke(IpcChannels.operationsCandidatesList),
  operationsCandidateResolve: (id, status) =>
    ipcRenderer.invoke(IpcChannels.operationsCandidateResolve, id, status),
  operationsTriage: () => ipcRenderer.invoke(IpcChannels.operationsTriage),
  operationsExecute: (adapterId, action, target, preview, params) =>
    ipcRenderer.invoke(IpcChannels.operationsExecute, adapterId, action, target, preview, params),
  onOperationsApprovalRequest: (listener) =>
    subscribe<IwatoRequestPayload>(IpcChannels.operationsApprovalRequest, listener),
  operationsApprovalRespond: (id, approved) =>
    ipcRenderer.invoke(IpcChannels.operationsApprovalRespond, id, approved),
  onOperationsApprovalResolved: (listener) =>
    subscribe<{ id: string; approved: boolean }>(IpcChannels.operationsApprovalResolved, listener),

  // M33: 神議アーキテクチャ
  operationsClocks: () => ipcRenderer.invoke(IpcChannels.operationsClocks),
  operationsClockUpdate: (id, patch) => ipcRenderer.invoke(IpcChannels.operationsClockUpdate, id, patch),
  operationsInboxList: (limit) => ipcRenderer.invoke(IpcChannels.operationsInboxList, limit),
  operationsInboxMarkRead: (ids) => ipcRenderer.invoke(IpcChannels.operationsInboxMarkRead, ids),
  operationsThreadList: () => ipcRenderer.invoke(IpcChannels.operationsThreadList),
  operationsThreadSend: (text) => ipcRenderer.invoke(IpcChannels.operationsThreadSend, text),
  operationsThreadBatches: () => ipcRenderer.invoke(IpcChannels.operationsThreadBatches),
  operationsThreadPending: () => ipcRenderer.invoke(IpcChannels.operationsThreadPending),
  operationsBatchRespond: (batchId, itemId, approved) =>
    ipcRenderer.invoke(IpcChannels.operationsBatchRespond, batchId, itemId, approved),
  operationsKamuhakariRun: () => ipcRenderer.invoke(IpcChannels.operationsKamuhakariRun),
  operationsGodDefs: () => ipcRenderer.invoke(IpcChannels.operationsGodDefs),
  operationsGodDefApply: (definition) => ipcRenderer.invoke(IpcChannels.operationsGodDefApply, definition),
};

contextBridge.exposeInMainWorld('api', api);
