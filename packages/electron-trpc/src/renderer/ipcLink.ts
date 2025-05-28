import { Operation, TRPCClientError, TRPCLink } from '@trpc/client';
import type { AnyRouter, inferRouterContext, ProcedureType } from '@trpc/server';
import type { TRPCResponseMessage } from '@trpc/server/rpc';
import type { RendererGlobalElectronTRPC, ETRPCRequest } from '../types';
import { observable, Observer } from '@trpc/server/observable';
import { transformResult } from './utils';
import debugFactory from 'debug';

const debug = debugFactory('electron-trpc:renderer:ipcLink');

type IPCCallbackResult<TRouter extends AnyRouter = AnyRouter> = TRPCResponseMessage<
  unknown,
  inferRouterContext<TRouter>
>;

type IPCCallbacks<TRouter extends AnyRouter = AnyRouter> = Observer<
  IPCCallbackResult<TRouter>,
  TRPCClientError<TRouter>
>;

type IPCRequest = {
  type: ProcedureType;
  callbacks: IPCCallbacks;
  op: Operation;
};

const getElectronTRPC = () => {
  const electronTRPC: RendererGlobalElectronTRPC = (globalThis as any).electronTRPC;

  if (!electronTRPC) {
    throw new Error(
      'Could not find `electronTRPC` global. Check that `exposeElectronTRPC` has been called in your preload file.'
    );
  }

  return electronTRPC;
};

let clientIdCounter = 0;

export class MessageRouter {
  private static instance: MessageRouter | null = null;
  private clients = new Map<string, IPCClient>();
  private electronTRPC: RendererGlobalElectronTRPC;
  private isInitialized = false;

  private constructor() {
    this.electronTRPC = getElectronTRPC();
  }

  static getInstance(): MessageRouter {
    if (!MessageRouter.instance) {
      MessageRouter.instance = new MessageRouter();
    }
    return MessageRouter.instance;
  }

  static reset(): void {
    MessageRouter.instance = null;
  }

  registerClient(client: IPCClient): string {
    const clientId = `c${++clientIdCounter}`;
    this.clients.set(clientId, client);

    if (!this.isInitialized) {
      this.electronTRPC.onMessage((response: TRPCResponseMessage) => {
        this.routeResponse(response);
      });
      this.isInitialized = true;
      debug('Global message handler initialized');
    }

    debug('Client registered:', clientId);
    return clientId;
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
    debug('Client unregistered:', clientId);
  }

  private routeResponse(response: TRPCResponseMessage): void {
    if (!response.id) return;

    const compositeId = String(response.id);
    const separatorIndex = compositeId.indexOf(':');

    if (separatorIndex === -1) {
      debug('Received non-composite ID, ignoring:', compositeId);
      return;
    }

    const clientId = compositeId.substring(0, separatorIndex);
    const originalIdStr = compositeId.substring(separatorIndex + 1);

    const originalId = isNaN(Number(originalIdStr)) ? originalIdStr : Number(originalIdStr);

    const client = this.clients.get(clientId);
    if (client) {
      const clientResponse = {
        ...response,
        id: originalId,
      };
      debug('Routing response to client:', clientId, 'originalId:', originalId);
      client.handleResponse(clientResponse);
    } else {
      debug('Client not found for response:', clientId);
    }
  }

  sendMessage(clientId: string, message: ETRPCRequest): void {
    let modifiedMessage: ETRPCRequest;

    if (message.method === 'request') {
      const compositeId = `${clientId}:${message.operation.id}`;
      modifiedMessage = {
        ...message,
        operation: {
          ...message.operation,
          id: compositeId as any,
        },
      };
    } else {
      const compositeId = `${clientId}:${message.id}`;
      modifiedMessage = {
        ...message,
        id: compositeId as any,
      };
    }

    debug('Sending message with composite ID:', modifiedMessage);
    this.electronTRPC.sendMessage(modifiedMessage);
  }
}

class IPCClient {
  #pendingRequests = new Map<string | number, IPCRequest>();
  #messageRouter = MessageRouter.getInstance();
  #clientId: string;

  constructor() {
    this.#clientId = this.#messageRouter.registerClient(this);
  }

  handleResponse(response: TRPCResponseMessage) {
    debug('handling response for client', this.#clientId, response);
    const request = response.id && this.#pendingRequests.get(response.id);
    if (!request) {
      debug('no pending request found for id', response.id);
      return;
    }

    request.callbacks.next(response);

    if ('result' in response && response.result.type === 'stopped') {
      request.callbacks.complete();
    }
  }

  request(op: Operation, callbacks: IPCCallbacks) {
    const { type, id } = op;

    this.#pendingRequests.set(id, {
      type,
      callbacks,
      op,
    });

    this.#messageRouter.sendMessage(this.#clientId, { method: 'request', operation: op });

    return () => {
      const callbacks = this.#pendingRequests.get(id)?.callbacks;

      this.#pendingRequests.delete(id);

      callbacks?.complete();

      if (type === 'subscription') {
        this.#messageRouter.sendMessage(this.#clientId, {
          id,
          method: 'subscription.stop',
        });
      }
    };
  }

  destroy() {
    this.#messageRouter.unregisterClient(this.#clientId);
  }
}

export function ipcLink<TRouter extends AnyRouter>(): TRPCLink<TRouter> {
  return (runtime: any) => {
    const client = new IPCClient();

    return ({ op }: any) => {
      return observable((observer: any) => {
        op.input = runtime.transformer.serialize(op.input);

        const unsubscribe = client.request(op, {
          error(err: any) {
            observer.error(err as TRPCClientError<any>);
            unsubscribe();
          },
          complete() {
            observer.complete();
          },
          next(response: any) {
            const transformed = transformResult(response, runtime);

            if (!transformed.ok) {
              observer.error(TRPCClientError.from(transformed.error));
              return;
            }

            observer.next({ result: transformed.result });

            if (op.type !== 'subscription') {
              unsubscribe();
              observer.complete();
            }
          },
        });

        return () => {
          unsubscribe();
        };
      });
    };
  };
}
