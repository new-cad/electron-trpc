import {
  callTRPCProcedure,
  getTRPCErrorShape,
  transformTRPCResponse,
  TRPCError,
} from '@trpc/server';
import type { AnyRouter, inferRouterContext } from '@trpc/server';
import type { TRPCResponseMessage } from '@trpc/server/rpc';
import type { IpcMainEvent } from 'electron';
import { isObservable, type Unsubscribable } from '@trpc/server/observable';
import { getTRPCErrorFromUnknown } from './utils';
import type { CreateContextOptions } from './types';
import { ELECTRON_TRPC_CHANNEL } from '../constants';
import type { ETRPCRequest } from '../types';
import debugFactory from 'debug';

const debug = debugFactory('electron-trpc:main:handleIPCMessage');

export async function handleIPCMessage<TRouter extends AnyRouter>({
  router,
  createContext,
  internalId,
  message,
  event,
  subscriptions,
  isActive = () => true,
}: {
  router: TRouter;
  createContext?: (
    opts: CreateContextOptions
  ) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
  internalId: string;
  message: ETRPCRequest;
  event: IpcMainEvent;
  subscriptions: Map<string, Unsubscribable>;
  isActive?: () => boolean;
}) {
  if (message.method === 'subscription.stop') {
    const subscription = subscriptions.get(internalId);
    subscriptions.delete(internalId);
    subscription?.unsubscribe();
    return;
  }

  const { type, input: serializedInput, path, id } = message.operation;
  let input: unknown;
  let ctx: inferRouterContext<TRouter> | undefined;
  let active = true;
  let subscription: Unsubscribable | undefined;
  const pending = { unsubscribe: finish };

  function finish() {
    if (!active) return;
    active = false;
    if (subscriptions.get(internalId) === pending) subscriptions.delete(internalId);
    try {
      subscription?.unsubscribe();
    } catch (error) {
      debug('Subscription cleanup failed', error);
    }
  }

  const respond = (response: TRPCResponseMessage) => {
    if (!active || !isActive() || event.sender.isDestroyed()) {
      finish();
      return;
    }
    event.reply(ELECTRON_TRPC_CHANNEL, transformTRPCResponse(router._def._config, response));
  };
  const fail = (cause: unknown) => {
    try {
      respond({
        id,
        error: getTRPCErrorShape({
          config: router._def._config,
          error: getTRPCErrorFromUnknown(cause),
          type,
          path,
          input,
          ctx,
        }),
      });
    } catch (error) {
      debug('Could not send IPC error', error);
    } finally {
      finish();
    }
  };

  if (type === 'subscription') {
    if (subscriptions.has(internalId)) {
      subscriptions.get(internalId)?.unsubscribe();
      fail(new TRPCError({ code: 'CONFLICT', message: 'Subscription ID is already active' }));
      return;
    }
    // Reserve before awaiting context/resolvers so cancellation and navigation can stop pending work.
    subscriptions.set(internalId, pending);
  }

  try {
    input =
      serializedInput === undefined
        ? undefined
        : router._def._config.transformer.input.deserialize(serializedInput);
    ctx = (await createContext?.({ event })) ?? {};
    if (!active || !isActive()) {
      finish();
      return;
    }
    const result = await callTRPCProcedure({
      ctx,
      path,
      router,
      signal: undefined,
      batchIndex: 0,
      getRawInput: async () => input,
      type,
    });
    if (!active || !isActive()) {
      finish();
      return;
    }

    if (type !== 'subscription') {
      respond({ id, result: { type: 'data', data: result } });
      return;
    }
    if (!isObservable(result)) {
      throw new TRPCError({
        message: `Subscription ${path} did not return an observable`,
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
    subscription = result.subscribe({
      next(data) {
        try {
          respond({ id, result: { type: 'data', data } });
        } catch (error) {
          fail(error);
        }
      },
      error: fail,
      complete() {
        try {
          respond({ id, result: { type: 'stopped' } });
        } catch (error) {
          fail(error);
        } finally {
          finish();
        }
      },
    });
    if (!active) subscription.unsubscribe();
  } catch (cause) {
    fail(cause);
  }
}
