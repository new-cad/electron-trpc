import {
  callTRPCProcedure,
  getTRPCErrorFromUnknown,
  getTRPCErrorShape,
  transformTRPCResponse,
  TRPCError,
} from '@trpc/server';
import type { AnyRouter, inferRouterContext } from '@trpc/server';
import type { TRPCResponseMessage } from '@trpc/server/rpc';
import type { IpcMainEvent } from 'electron';
import { isObservable, type Unsubscribable } from '@trpc/server/observable';
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
  isAuthorized = () => true,
}: {
  router: TRouter;
  createContext?: (
    opts: CreateContextOptions
  ) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
  internalId: string;
  message: ETRPCRequest;
  event: IpcMainEvent;
  subscriptions: Map<string, Unsubscribable>;
  /** Whether the sender is still attached to the document this request arrived from. */
  isAuthorized?: () => boolean;
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

  function finish() {
    if (!active) return;
    active = false;
    if (subscriptions.get(internalId) === handle) subscriptions.delete(internalId);
    try {
      subscription?.unsubscribe();
    } catch (error) {
      debug('Subscription cleanup failed', error);
    }
  }
  const handle = { unsubscribe: finish };

  const cancelled = () => !active || !isAuthorized() || event.sender.isDestroyed();
  const respond = (response: TRPCResponseMessage) => {
    if (cancelled()) {
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
    const existing = subscriptions.get(internalId);
    if (existing) {
      existing.unsubscribe();
      fail(new TRPCError({ code: 'CONFLICT', message: 'Subscription ID is already active' }));
      return;
    }
    // Reserve before awaiting context/resolvers so cancellation and navigation can stop pending work.
    // The map holds `handle` rather than the stream because the stream does not exist yet.
    subscriptions.set(internalId, handle);
  }

  try {
    if (serializedInput !== undefined) {
      try {
        input = router._def._config.transformer.input.deserialize(serializedInput);
      } catch (cause) {
        throw new TRPCError({ code: 'PARSE_ERROR', cause });
      }
    }
    ctx = (await createContext?.({ event })) ?? {};
    if (cancelled()) {
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
    if (cancelled()) {
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
    // `finish()` may already have run inside `subscribe()` (synchronous complete/error), before
    // `subscription` was assigned, so the stream still has to be released here.
    if (!active) subscription.unsubscribe();
  } catch (cause) {
    fail(cause);
  }
}
