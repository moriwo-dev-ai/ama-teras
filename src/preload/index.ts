import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannels, type MyCodexApi } from '../shared/ipc';
import type { AgentEvent } from '../shared/types';

const api: MyCodexApi = {
  chatSend: (text) => ipcRenderer.invoke(IpcChannels.chatSend, text),
  chatCancel: (sessionId) => ipcRenderer.invoke(IpcChannels.chatCancel, sessionId),
  onChatEvent: (listener) => {
    const wrapped = (_e: Electron.IpcRendererEvent, event: AgentEvent): void => listener(event);
    ipcRenderer.on(IpcChannels.chatEvent, wrapped);
    return () => ipcRenderer.removeListener(IpcChannels.chatEvent, wrapped);
  },
};

contextBridge.exposeInMainWorld('api', api);
