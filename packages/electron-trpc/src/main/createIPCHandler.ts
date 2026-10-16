import type { AnyRouter, inferRouterContext } from '@trpc/server';
import type { Unsubscribable } from '@trpc/server/observable';
import debugFactory from 'debug';
import { ipcMain, type BrowserWindow, type IpcMainEvent, type WebContents } from 'electron';
import { ELECTRON_TRPC_CHANNEL } from '../constants';
import type { ETRPCRequest } from '../types';
import { handleIPCMessage } from './handleIPCMessage';
import type { CreateContextOptions } from './types';

const debug = debugFactory('electron-trpc:main:IPCHandler');

type HandlerOptions<TRouter extends AnyRouter> = {
  router: TRouter;
  createContext?: (
    opts: CreateContextOptions
  ) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
  windows?: BrowserWindow[];
  validateSender?: (event: IpcMainEvent) => boolean;
};

type AttachedWindow = {
  contents: WebContents;
  // Cached because reading `id` from a destroyed WebContents throws.
  id: number;
  // Bumped when the document is replaced or its renderer dies. Each request remembers the value it
  // arrived under; queries and mutations have no `subscriptions` entry, so this is what stops them
  // from replying into a replacement document.
  generation: number;
  // Process and routing id of the current document's main frame. Every document gets its own, so a
  // changed id without `did-navigate` means a failed load put Chromium's error page in its place.
  // (`contents.mainFrame` can return the same object for the replacement, so objects are not
  // compared.) Unreadable while the renderer is gone.
  frame: string | undefined;
  removeListeners: () => void;
};

// Reading the main frame throws once its renderer is gone, for example after a crash.
function mainFrameId(contents: WebContents) {
  try {
    const { processId, routingId } = contents.mainFrame;
    return `${processId}:${routingId}`;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown) {
  return (
    (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
  );
}

function isIPCRequest(value: unknown): value is ETRPCRequest {
  if (!isRecord(value)) return false;
  if (value.method === 'subscription.stop') return isRequestId(value.id);
  if (value.method !== 'request' || !isRecord(value.operation)) return false;
  const { id, path, type } = value.operation;
  return (
    isRequestId(id) &&
    typeof path === 'string' &&
    path.length > 0 &&
    (type === 'query' || type === 'mutation' || type === 'subscription')
  );
}

class IPCHandler<TRouter extends AnyRouter> {
  #windows = new Map<BrowserWindow, AttachedWindow>();
  #senders = new Map<WebContents, AttachedWindow>();
  #subscriptions = new Map<string, Unsubscribable>();
  #disposed = false;
  #onMessage: (event: IpcMainEvent, request: unknown) => void;

  constructor({ createContext, router, windows = [], validateSender }: HandlerOptions<TRouter>) {
    // Rejected requests get no reply, so every early return below is logged for diagnosis.
    this.#onMessage = (event, request) => {
      const attached = this.#senders.get(event.sender);
      if (!attached) {
        debug('Ignored IPC message from a webContents that is not an attached window');
        return;
      }
      const frame = event.senderFrame;
      if (event.sender.isDestroyed() || !frame || frame !== event.sender.mainFrame) {
        debug(
          'Ignored IPC message from a destroyed webContents or a frame other than the main frame'
        );
        return;
      }
      if (!isIPCRequest(request)) {
        debug('Ignored malformed IPC message');
        return;
      }
      try {
        if (validateSender && validateSender(event) !== true) {
          debug('Ignored IPC message rejected by validateSender');
          return;
        }
      } catch (error) {
        debug('Sender validation failed', error);
        return;
      }
      // A document's commit is handled before its first IPC message, so a replacement document's
      // requests are accepted under the new generation. The Electron smoke test pins this.
      const generation = attached.generation;
      const messageId = request.method === 'request' ? request.operation.id : request.id;
      void handleIPCMessage({
        router,
        createContext,
        event,
        message: request,
        internalId: `${event.sender.id}:${frame.routingId}:${messageId}`,
        subscriptions: this.#subscriptions,
        isAuthorized: () =>
          this.#senders.get(event.sender) === attached && generation === attached.generation,
      }).catch((error: unknown) => debug('IPC request failed', error));
    };
    try {
      windows.forEach((win) => this.attachWindow(win));
    } catch (error) {
      this.dispose();
      throw error;
    }
    ipcMain.on(ELECTRON_TRPC_CHANNEL, this.#onMessage);
  }

  attachWindow(win: BrowserWindow) {
    if (this.#disposed) throw new Error('Cannot attach a window to a disposed IPC handler');
    if (this.#windows.has(win)) return;
    if (win.isDestroyed() || win.webContents.isDestroyed())
      throw new Error('Cannot attach a destroyed window');
    const contents = win.webContents;
    const attached: AttachedWindow = {
      contents,
      id: contents.id,
      generation: 0,
      frame: mainFrameId(contents),
      removeListeners: () => {
        contents.removeListener('did-navigate', onNavigate);
        contents.removeListener('did-fail-load', onFailLoad);
        contents.removeListener('destroyed', onDestroyed);
        contents.removeListener('render-process-gone', invalidate);
      },
    };
    const invalidate = () => {
      attached.generation++;
      this.#cleanUpSubscriptions(attached.id);
    };
    const onNavigate = () => {
      invalidate();
      attached.frame = mainFrameId(contents);
    };
    const onFailLoad = () => {
      // Failures that leave the document in place (an invalid URL, a cancelled navigation), that
      // happen in a subframe, or that follow a commit (a truncated body) keep the tracked frame.
      if (mainFrameId(contents) !== attached.frame) onNavigate();
    };
    const onDestroyed = () => this.detachWindow(win);
    this.#windows.set(win, attached);
    this.#senders.set(contents, attached);
    // The document is replaced either by a committed navigation (`did-navigate`) or by Chromium's
    // error page, which emits only `did-fail-load`. `did-start-navigation` is not used because it
    // also fires for downloads, 204 responses, and navigations cancelled in `will-navigate`, none of
    // which replace the document.
    contents.on('did-navigate', onNavigate);
    contents.on('did-fail-load', onFailLoad);
    contents.on('destroyed', onDestroyed);
    contents.on('render-process-gone', invalidate);
  }

  detachWindow(win: BrowserWindow, webContentsId?: number) {
    const attached = this.#windows.get(win);
    if (!attached) return;
    if (webContentsId !== undefined && attached.id !== webContentsId) {
      throw new Error('webContentsId does not match the attached window');
    }
    this.#windows.delete(win);
    this.#senders.delete(attached.contents);
    attached.removeListeners();
    this.#cleanUpSubscriptions(attached.id);
  }

  #cleanUpSubscriptions(webContentsId: number) {
    for (const [key, subscription] of this.#subscriptions) {
      if (key.startsWith(`${webContentsId}:`)) {
        this.#subscriptions.delete(key);
        subscription.unsubscribe();
      }
    }
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    ipcMain.removeListener(ELECTRON_TRPC_CHANNEL, this.#onMessage);
    for (const win of this.#windows.keys()) this.detachWindow(win);
  }
}

export const createIPCHandler = <TRouter extends AnyRouter>(options: HandlerOptions<TRouter>) =>
  new IPCHandler(options);
