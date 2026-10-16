import { ipcRenderer, contextBridge } from 'electron';
import { ELECTRON_TRPC_CHANNEL } from '../constants';
import type { RendererGlobalElectronTRPC } from '../types';

export const exposeElectronTRPC = () => {
  const electronTRPC: RendererGlobalElectronTRPC = {
    sendMessage: (operation) => ipcRenderer.send(ELECTRON_TRPC_CHANNEL, operation),
    onMessage: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, args: Parameters<typeof callback>[0]) =>
        callback(args);
      ipcRenderer.on(ELECTRON_TRPC_CHANNEL, listener);
      return () => {
        ipcRenderer.removeListener(ELECTRON_TRPC_CHANNEL, listener);
      };
    },
  };
  contextBridge.exposeInMainWorld('electronTRPC', electronTRPC);
};
