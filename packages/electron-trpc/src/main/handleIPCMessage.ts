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
import type { ETRPCRequest, WireFormat } from '../types';
import debugFactory from 'debug';

const debug = debugFactory('electron-trpc:main:handleIPCMessage');

export type ContextFactory<TRouter extends AnyRouter> = (
  opts: CreateContextOptions
) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;

export async function handleIPCMessage<TRouter extends AnyRouter>({
  router,
  createContext,
  internalId,
  message,
  event,
  subscriptions,
  isAuthorized = () => true,
  wireFormat = 'structured-clone',
}: {
  router: TRouter;
  createContext?: ContextFactory<TRouter>;
  internalId: string;
  message: ETRPCRequest;
  event: IpcMainEvent;
  subscriptions: Map<string, Unsubscribable>;
  /** Whether the sender is still attached to the document this request arrived from. */
  isAuthorized?: () => boolean;
  /** Replies are sent as JSON text when the request arrived as JSON text. */
  wireFormat?: WireFormat;
}) {
  if (message.method === 'subscription.stop') {
    const subscription = subscriptions.get(internalId);
    subscriptions.delete(internalId);
    subscription?.unsubscribe();
    return;
  }

  const { type, input: serializedInput, path, id } = message.operation;
  const config = router._def._config;
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
    // Checked before any transformer runs, so none runs for a sender that has lost access.
    if (cancelled()) {
      finish();
      return;
    }
    // Data replies carry every result and subscription event, so they skip the object spreads in
    // transformTRPCResponse. Its data branch is the source of truth; handleIPCMessage.test.ts pins
    // that the output is identical, so re-run it when upgrading tRPC.
    const reply =
      'result' in response && response.result.type === 'data'
        ? {
            id: response.id,
            result: {
              type: 'data',
              data: config.transformer.output.serialize(response.result.data),
            },
          }
        : transformTRPCResponse(config, response);
    event.reply(ELECTRON_TRPC_CHANNEL, wireFormat === 'json' ? JSON.stringify(reply) : reply);
  };
  const fail = (cause: unknown) => {
    try {
      respond({
        id,
        error: getTRPCErrorShape({
          config,
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
        input = config.transformer.input.deserialize(serializedInput);
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
