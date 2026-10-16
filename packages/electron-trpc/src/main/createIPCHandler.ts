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
  id: number;
  generation: number;
  removeListeners: () => void;
};

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
    this.#onMessage = (event, request) => {
      const attached = this.#senders.get(event.sender);
      if (
        !attached ||
        event.sender.isDestroyed() ||
        !event.senderFrame ||
        event.senderFrame !== event.sender.mainFrame ||
        !isIPCRequest(request)
      ) {
        return;
      }
      try {
        if (validateSender && validateSender(event) !== true) return;
      } catch (error) {
        debug('Sender validation failed', error);
        return;
      }
      const generation = attached.generation;
      const messageId = request.method === 'request' ? request.operation.id : request.id;
      void handleIPCMessage({
        router,
        createContext,
        event,
        message: request,
        internalId: `${event.sender.id}:${event.senderFrame.routingId}:${messageId}`,
        subscriptions: this.#subscriptions,
        isActive: () =>
          this.#senders.get(event.sender) === attached &&
          generation === attached.generation &&
          !event.sender.isDestroyed(),
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
      removeListeners: () => {
        contents.removeListener('did-start-navigation', onNavigation);
        contents.removeListener('destroyed', onDestroyed);
        contents.removeListener('render-process-gone', onProcessGone);
      },
    };
    const invalidate = () => {
      attached.generation++;
      this.#cleanUpSubscriptions(attached.id);
    };
    const onNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
    ) => {
      if (details.isMainFrame && !details.isSameDocument) invalidate();
    };
    const onDestroyed = () => this.detachWindow(win);
    const onProcessGone = () => invalidate();
    this.#windows.set(win, attached);
    this.#senders.set(contents, attached);
    contents.on('did-start-navigation', onNavigation);
    contents.on('destroyed', onDestroyed);
    contents.on('render-process-gone', onProcessGone);
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
