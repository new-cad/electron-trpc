import { createTRPCClient, type TRPCLink } from '@trpc/client';
import {
  initTRPC,
  TRPCError,
  type AnyRouter,
  type DataTransformer,
  type CombinedDataTransformer,
} from '@trpc/server';
import { observable, type Observer, type Unsubscribable } from '@trpc/server/observable';
import type { TRPCResponseMessage } from '@trpc/server/rpc';
import type { IpcMainEvent } from 'electron';
import superjson from 'superjson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { handleIPCMessage } from '../../main/handleIPCMessage';
import type { ETRPCRequest, RendererGlobalElectronTRPC } from '../../types';
import { ipcLink, MessageRouter } from '../ipcLink';

function connect<TRouter extends AnyRouter>(
  router: TRouter,
  transformer?: DataTransformer | CombinedDataTransformer,
  links: TRPCLink<TRouter>[] = []
) {
  let receive = (_response: TRPCResponseMessage) => {};
  const subscriptions = new Map<string, Unsubscribable>();
  const event = {
    reply: (_channel: string, response: TRPCResponseMessage) => receive(response),
    sender: { isDestroyed: () => false },
  } as unknown as IpcMainEvent;
  const bridge: RendererGlobalElectronTRPC = {
    onMessage: (handler) => {
      receive = handler;
    },
    sendMessage: (message: ETRPCRequest) => {
      const id = message.method === 'request' ? message.operation.id : message.id;
      void handleIPCMessage({ router, event, message, internalId: String(id), subscriptions });
    },
  };
  vi.stubGlobal('electronTRPC', bridge);
  return {
    client: createTRPCClient<TRouter>({ links: [...links, ipcLink({ transformer })] }),
    subscriptions,
  };
}

afterEach(() => {
  MessageRouter.reset();
  vi.unstubAllGlobals();
});

describe('tRPC v11 IPC transport', () => {
  test('returns a formatted failure when input deserialization throws', async () => {
    const t = initTRPC.create({
      transformer: {
        input: {
          serialize: (value) => value,
          deserialize: () => {
            throw new Error('Invalid encoded input');
          },
        },
        output: { serialize: (value) => value, deserialize: (value) => value },
      },
    });
    const read = vi.fn();
    const router = t.router({ read: t.procedure.input(z.unknown()).mutation(read) });
    const { client } = connect(router);
    await expect(client.read.mutate('bad')).rejects.toMatchObject({
      message: 'Invalid encoded input',
      data: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(read).not.toHaveBeenCalled();
  });

  test.each([false, 0, '', null])('preserves falsy serialized input: %j', async (value) => {
    const t = initTRPC.create();
    const router = t.router({
      echo: t.procedure.input(z.unknown()).mutation(({ input }) => input),
    });
    const { client } = connect(router);
    expect(await client.echo.mutate(value)).toBe(value);
  });

  test('releases a subscription that completes synchronously', async () => {
    const t = initTRPC.create();
    const cleanup = vi.fn();
    const router = t.router({
      stream: t.procedure.subscription(() =>
        observable<number>((emit) => {
          emit.next(1);
          emit.complete();
          return cleanup;
        })
      ),
    });
    const { client, subscriptions } = connect(router);
    const onData = vi.fn();
    const onComplete = vi.fn();
    client.stream.subscribe(undefined, { onData, onComplete });
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onData).toHaveBeenCalledWith(1);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(subscriptions.size).toBe(0);
  });
  test('round-trips transformed queries and mutations without changing preceding link operations', async () => {
    const t = initTRPC.create({ transformer: superjson });
    const input = z.object({ date: z.date(), count: z.bigint() });
    const router = t.router({
      read: t.procedure.input(input).query(({ input }) => input),
      write: t.procedure.input(input).mutation(({ input }) => input),
    });
    const originalInputs: unknown[] = [];
    const capture: TRPCLink<typeof router> =
      () =>
      ({ op, next }) => {
        originalInputs.push(op.input);
        return next(Object.freeze(op));
      };
    const { client } = connect(router, superjson, [capture]);
    const value = { date: new Date('2026-01-01T00:00:00Z'), count: 42n };
    expect(await client.read.query(value)).toEqual(value);
    expect(await client.write.mutate(value)).toEqual(value);
    expect(originalInputs).toEqual([value, value]);
  });

  test('uses separate input/output transformers and the router error formatter', async () => {
    const transformer = {
      input: superjson,
      output: { serialize: JSON.stringify, deserialize: JSON.parse },
    };
    const t = initTRPC.create({
      transformer,
      errorFormatter: ({ shape }) => ({ ...shape, data: { ...shape.data, transport: 'ipc' } }),
    });
    const router = t.router({
      year: t.procedure.input(z.date()).mutation(({ input }) => input.getUTCFullYear()),
    });
    const { client } = connect(router, transformer);
    expect(await client.year.mutate(new Date('2026-01-01T00:00:00Z'))).toBe(2026);
    await expect(client.year.mutate('invalid' as unknown as Date)).rejects.toMatchObject({
      data: { code: 'BAD_REQUEST', transport: 'ipc' },
    });
  });

  test('serializes subscription results and errors and handles unsubscribe', async () => {
    const t = initTRPC.create({ transformer: superjson });
    let emit: Observer<Date, unknown> | undefined;
    const cleanup = vi.fn();
    const router = t.router({
      dates: t.procedure.subscription(() =>
        observable<Date>((observer) => {
          emit = observer;
          return cleanup;
        })
      ),
    });
    const { client, subscriptions } = connect(router, superjson);
    const onData = vi.fn();
    const onError = vi.fn();
    const subscription = client.dates.subscribe(undefined, { onData, onError });
    await vi.waitFor(() => expect(emit).toBeDefined());
    const date = new Date('2026-01-01T00:00:00Z');
    emit!.next(date);
    expect(onData).toHaveBeenCalledWith(date);
    emit!.error(new TRPCError({ code: 'FORBIDDEN', message: 'Subscription denied' }));
    expect(subscriptions.size).toBe(0);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Subscription denied',
        data: expect.objectContaining({ code: 'FORBIDDEN' }),
      })
    );
    subscription.unsubscribe();
    expect(cleanup).toHaveBeenCalledOnce();

    const previous = emit;
    const active = client.dates.subscribe(undefined, { onData });
    await vi.waitFor(() => expect(emit).not.toBe(previous));
    active.unsubscribe();
    expect(subscriptions.size).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
