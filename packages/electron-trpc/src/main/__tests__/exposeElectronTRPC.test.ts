import { ipcRenderer, contextBridge } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';
import { ELECTRON_TRPC_CHANNEL } from '../../constants';
import type { RendererGlobalElectronTRPC } from '../../types';
import { exposeElectronTRPC } from '../exposeElectronTRPC';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    ipcRenderer: Object.assign(new EventEmitter(), { send: vi.fn() }),
    contextBridge: { exposeInMainWorld: vi.fn() },
  };
});
beforeEach(() => {
  ipcRenderer.removeAllListeners();
  vi.clearAllMocks();
});

test('exposes only the transport and returns a removable listener without exposing the Electron event', () => {
  exposeElectronTRPC();
  const bridge = vi.mocked(contextBridge.exposeInMainWorld).mock
    .calls[0][1] as RendererGlobalElectronTRPC;
  const callback = vi.fn();
  const remove = bridge.onMessage(callback);
  const response = { id: 'c1:1', result: { type: 'data', data: 'ok' } };
  ipcRenderer.emit(ELECTRON_TRPC_CHANNEL, { sender: ipcRenderer }, response);
  expect(callback).toHaveBeenCalledWith(response);
  expect(callback.mock.calls[0]).toHaveLength(1);
  expect(typeof remove).toBe('function');
  if (typeof remove === 'function') {
    remove();
    remove();
  }
  expect(ipcRenderer.listenerCount(ELECTRON_TRPC_CHANNEL)).toBe(0);
  const message = { method: 'subscription.stop', id: 'c1:1' } as const;
  bridge.sendMessage(message);
  expect(ipcRenderer.send).toHaveBeenCalledWith(ELECTRON_TRPC_CHANNEL, message);
});
