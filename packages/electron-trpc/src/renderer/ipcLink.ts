import { type Operation, TRPCClientError, type TRPCLink } from '@trpc/client';
import type { AnyRouter, CombinedDataTransformer, DataTransformer } from '@trpc/server';
import type { TRPCResponseMessage } from '@trpc/server/rpc';
import type { RendererGlobalElectronTRPC, ETRPCRequest } from '../types';
import { observable, type Observer } from '@trpc/server/observable';
import { transformResult } from './utils';
import debugFactory from 'debug';

const debug = debugFactory('electron-trpc:renderer:ipcLink');
type IPCCallbacks = Observer<TRPCResponseMessage, TRPCClientError<AnyRouter>>;
type IPCRequest = { callbacks: IPCCallbacks; finish: (notifyServer: boolean) => void };

function clientError(cause: unknown) {
  return TRPCClientError.from(
    cause instanceof Error
      ? cause
      : new Error(typeof cause === 'string' ? cause : 'IPC transport failed')
  );
}

const getElectronTRPC = () => {
  const bridge = (globalThis as typeof globalThis & { electronTRPC?: RendererGlobalElectronTRPC })
    .electronTRPC;
  if (!bridge)
    throw new Error(
      'Could not find `electronTRPC` global. Check that `exposeElectronTRPC` has been called in your preload file.'
    );
  return bridge;
};

let clientIdCounter = 0;
// Client ids restart in every document, so they carry a per-document token: a late reply addressed to
// a client of the previous document can then never be routed to a client of this one.
const documentToken = Math.random().toString(36).slice(2, 8);

export class MessageRouter {
  private static instance: MessageRouter | null = null;
  private clients = new Map<string, IPCClient>();
  private electronTRPC = getElectronTRPC();
  private isInitialized = false;
  private removeListener?: () => void;

  private constructor() {}

  static getInstance(): MessageRouter {
    return (MessageRouter.instance ??= new MessageRouter());
  }

  static reset(): void {
    MessageRouter.instance?.removeListener?.();
    MessageRouter.instance?.clients.clear();
    MessageRouter.instance = null;
  }

  registerClient(client: IPCClient): string {
    if (!this.isInitialized) {
      const remove = this.electronTRPC.onMessage((response) => this.routeResponse(response));
      this.removeListener = typeof remove === 'function' ? remove : undefined;
      this.isInitialized = true;
    }
    const id = `c${++clientIdCounter}-${documentToken}`;
    this.clients.set(id, client);
    return id;
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
    if (this.clients.size === 0 && this.removeListener) {
      const remove = this.removeListener;
      this.removeListener = undefined;
      this.isInitialized = false;
      remove();
    }
  }

  private routeResponse(response: TRPCResponseMessage): void {
    if (response.id == null) return;
    const compositeId = String(response.id);
    const separator = compositeId.indexOf(':');
    if (separator < 0) return;
    const clientId = compositeId.slice(0, separator);
    const id = Number(compositeId.slice(separator + 1));
    if (!Number.isSafeInteger(id) || id < 0) return;
    this.clients.get(clientId)?.handleResponse({ ...response, id });
  }

  sendMessage(clientId: string, message: ETRPCRequest): void {
    if (message.method === 'request') {
      const { operation } = message;
      this.electronTRPC.sendMessage({
        method: 'request',
        operation: {
          id: `${clientId}:${operation.id}`,
          context: operation.context,
          path: operation.path,
          type: operation.type,
          input: operation.input,
        },
      });
    } else {
      this.electronTRPC.sendMessage({
        method: 'subscription.stop',
        id: `${clientId}:${message.id}`,
      });
    }
  }
}

class IPCClient {
  #pendingRequests = new Map<number, IPCRequest>();
  #messageRouter = MessageRouter.getInstance();
  #clientId?: string;

  handleResponse(response: TRPCResponseMessage) {
    if (typeof response.id !== 'number') return;
    const request = this.#pendingRequests.get(response.id);
    if (!request) return;
    if ('error' in response || response.result.type === 'stopped') request.finish(false);
    request.callbacks.next(response);
    if ('result' in response && response.result.type === 'stopped') request.callbacks.complete();
  }

  request(op: Operation, callbacks: IPCCallbacks) {
    const { id, type, signal } = op;
    const finish = (notifyServer: boolean) => {
      if (!this.#pendingRequests.delete(id)) return;
      signal?.removeEventListener('abort', abort);
      const clientId = this.#clientId;
      try {
        if (notifyServer && type === 'subscription' && clientId) {
          this.#messageRouter.sendMessage(clientId, { method: 'subscription.stop', id });
        }
      } catch (error) {
        debug('Could not stop subscription', error);
      } finally {
        if (this.#pendingRequests.size === 0 && clientId) {
          this.#clientId = undefined;
          this.#messageRouter.unregisterClient(clientId);
        }
      }
    };
    const abort = () => {
      finish(true);
      callbacks.error(
        TRPCClientError.from(new DOMException('The operation was aborted', 'AbortError'))
      );
    };
    if (signal?.aborted) {
      abort();
      return () => {};
    }
    try {
      this.#clientId ??= this.#messageRouter.registerClient(this);
      this.#pendingRequests.set(id, { callbacks, finish });
      signal?.addEventListener('abort', abort, { once: true });
      this.#messageRouter.sendMessage(this.#clientId, { method: 'request', operation: op });
    } catch (error) {
      finish(false);
      callbacks.error(clientError(error));
    }
    return () => {
      if (!this.#pendingRequests.has(id)) return;
      finish(true);
      callbacks.complete();
    };
  }
}

export function ipcLink<TRouter extends AnyRouter>({
  transformer = { serialize: (value: unknown) => value, deserialize: (value: unknown) => value },
}: { transformer?: DataTransformer | CombinedDataTransformer } = {}): TRPCLink<TRouter> {
  const { input, output } =
    'input' in transformer ? transformer : { input: transformer, output: transformer };
  return () => {
    const client = new IPCClient();
    return ({ op }) =>
      observable((observer) => {
        let operation: Operation;
        try {
          operation = { ...op, input: input.serialize(op.input) };
        } catch (error) {
          observer.error(clientError(error));
          return;
        }
        return client.request(operation, {
          error: (error) => observer.error(error),
          complete: () => observer.complete(),
          next(response) {
            try {
              const transformed = transformResult(response, output);
              if (!transformed.ok) {
                observer.error(TRPCClientError.from(transformed.error));
                return;
              }
              observer.next({ result: transformed.result });
              if (op.type !== 'subscription') observer.complete();
            } catch (error) {
              observer.error(clientError(error));
            }
          },
        });
      });
  };
}
