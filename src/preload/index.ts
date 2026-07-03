import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, type MyCodexApi } from '../shared/ipc';
import type { AgentEvent, ApprovalRequestPayload, EvolutionEvent } from '../shared/types';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_e: Electron.IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: MyCodexApi = {
  chatSend: (text) => ipcRenderer.invoke(IpcChannels.chatSend, text),
  chatCancel: (sessionId) => ipcRenderer.invoke(IpcChannels.chatCancel, sessionId),
  onChatEvent: (listener) => subscribe<AgentEvent>(IpcChannels.chatEvent, listener),

  onApprovalRequest: (listener) =>
    subscribe<ApprovalRequestPayload>(IpcChannels.approvalRequest, listener),
  approvalRespond: (id, decision) => ipcRenderer.invoke(IpcChannels.approvalRespond, id, decision),

  toolsList: () => ipcRenderer.invoke(IpcChannels.toolsList),
  toolsExecute: (name, inputJson) => ipcRenderer.invoke(IpcChannels.toolsExecute, name, inputJson),
  toolsReload: () => ipcRenderer.invoke(IpcChannels.toolsReload),

  settingsGet: () => ipcRenderer.invoke(IpcChannels.settingsGet),
  settingsSet: (config) => ipcRenderer.invoke(IpcChannels.settingsSet, config),
  pickWorkspace: () => ipcRenderer.invoke(IpcChannels.workspacePick),
  memoryGet: () => ipcRenderer.invoke(IpcChannels.memoryGet),
  memorySet: (content) => ipcRenderer.invoke(IpcChannels.memorySet, content),

  secretsSet: (provider, apiKey) => ipcRenderer.invoke(IpcChannels.secretsSet, provider, apiKey),
  secretsStatus: () => ipcRenderer.invoke(IpcChannels.secretsStatus),

  onEvolutionEvent: (listener) => subscribe<EvolutionEvent>(IpcChannels.evolutionEvent, listener),
  evolutionPromoteRespond: (jobId, approved) =>
    ipcRenderer.invoke(IpcChannels.evolutionPromoteRespond, jobId, approved),
  evolutionEnqueue: (description, expectedIo) =>
    ipcRenderer.invoke(IpcChannels.evolutionEnqueue, description, expectedIo),
  evolutionList: () => ipcRenderer.invoke(IpcChannels.evolutionList),
};

contextBridge.exposeInMainWorld('api', api);
