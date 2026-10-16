import type { IpcMainEvent } from 'electron';
import { EventEmitter } from 'events';
import * as trpc from '@trpc/server';
import { observable, type Unsubscribable } from '@trpc/server/observable';
import { describe, expect, test, vi, type MockedFunction } from 'vitest';
import { z } from 'zod';
import { handleIPCMessage } from '../handleIPCMessage';

type Operation = { path: string; type: 'query' | 'mutation' | 'subscription'; input?: unknown };
type Options = Pick<Parameters<typeof handleIPCMessage>[0], 'createContext' | 'isAuthorized'>;

// Runs one operation through the handler; `reply` stands in for the renderer.
async function run(
  router: trpc.AnyRouter,
  operation: Operation,
  {
    reply = vi.fn(),
    destroyed = false,
    ...options
  }: Options & {
    reply?: MockedFunction<(channel: string, response: unknown) => void>;
    destroyed?: boolean;
  } = {}
) {
  const event = { reply, sender: { isDestroyed: () => destroyed } } as unknown as IpcMainEvent;
  const subscriptions = new Map<string, Unsubscribable>();
  await handleIPCMessage({
    router,
    event,
    internalId: '1:1:1',
    message: { method: 'request', operation: { id: 1, input: undefined, ...operation } },
    subscriptions,
    ...options,
  });
  return { reply, subscriptions, lastReply: () => reply.mock.lastCall![1] };
}

// A router whose subscription forwards 'tick' events from `source`.
function tickRouter(source: EventEmitter) {
  const t = trpc.initTRPC.create();
  return t.router({
    stream: t.procedure.subscription(() =>
      observable((emit) => {
        const onTick = () => emit.next('tick');
        source.on('tick', onTick);
        return () => source.off('tick', onTick);
      })
    ),
  });
}

describe('api', () => {
  test('handles queries', async () => {
    const t = trpc.initTRPC.create();
    const router = t.router({
      testQuery: t.procedure
        .input(z.object({ id: z.string() }))
        .query(({ input }) => ({ id: input.id, isTest: true })),
    });

    const { reply, lastReply } = await run(router, {
      path: 'testQuery',
      type: 'query',
      input: { id: 'test-id' },
    });

    expect(reply).toHaveBeenCalledOnce();
    expect(lastReply()).toMatchObject({ id: 1, result: { data: { id: 'test-id', isTest: true } } });
  });

  test('does not respond if sender is gone', async () => {
    const t = trpc.initTRPC.create();
    const router = t.router({ testQuery: t.procedure.query(() => 'ok') });

    const { reply } = await run(router, { path: 'testQuery', type: 'query' }, { destroyed: true });

    expect(reply).not.toHaveBeenCalled();
  });

  test('handles subscriptions', async () => {
    const source = new EventEmitter();

    const { reply, lastReply } = await run(tickRouter(source), {
      path: 'stream',
      type: 'subscription',
    });
    expect(reply).not.toHaveBeenCalled();
    source.emit('tick');

    expect(reply).toHaveBeenCalledOnce();
    expect(lastReply()).toMatchObject({ id: 1, result: { data: 'tick' } });
  });

  test('releases a stream that ends while it is still subscribing', async () => {
    const unsubscribe = vi.fn();
    const t = trpc.initTRPC.create();
    const router = t.router({
      stream: t.procedure.subscription(
        () =>
          ({
            subscribe(observer: { complete(): void }) {
              observer.complete();
              return { unsubscribe };
            },
          }) as never
      ),
    });

    const { subscriptions, lastReply } = await run(router, {
      path: 'stream',
      type: 'subscription',
    });

    expect(lastReply()).toMatchObject({ result: { type: 'stopped' } });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(subscriptions.size).toBe(0);
  });

  test('releases a stream whose replies can no longer be delivered', async () => {
    const source = new EventEmitter();
    const reply = vi.fn(() => {
      throw new Error('Frame was disposed');
    });

    const { subscriptions } = await run(
      tickRouter(source),
      { path: 'stream', type: 'subscription' },
      { reply }
    );
    source.emit('tick');

    expect(source.listenerCount('tick')).toBe(0);
    expect(subscriptions.size).toBe(0);
  });

  test('stops replying once a subscription is stopped, even if its source keeps emitting', async () => {
    const source = new EventEmitter();
    const serialize = vi.fn((value: unknown) => value);
    const identity = { serialize, deserialize: (value: unknown) => value };
    const t = trpc.initTRPC.create({ transformer: { input: identity, output: identity } });
    const router = t.router({
      stream: t.procedure.subscription(() =>
        observable((emit) => {
          source.on('tick', () => emit.next('tick'));
          return () => {}; // teardown that does not detach the source
        })
      ),
    });

    const { reply, subscriptions } = await run(router, { path: 'stream', type: 'subscription' });
    subscriptions.get('1:1:1')!.unsubscribe();
    source.emit('tick');

    expect(reply).not.toHaveBeenCalled();
    expect(serialize).not.toHaveBeenCalled(); // no transformer runs for a sender that lost access
    expect(subscriptions.size).toBe(0);
  });

  test('reports a thrown non-Error value as an internal error', async () => {
    const t = trpc.initTRPC.create();
    const router = t.router({ read: t.procedure.query(() => 'ok') });

    const { reply, lastReply } = await run(
      router,
      { path: 'read', type: 'query' },
      {
        createContext: async () => {
          throw { reason: 'not an Error' };
        },
      }
    );

    expect(reply).toHaveBeenCalledOnce();
    expect(lastReply()).toMatchObject({
      id: 1,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });
  });

  test('reports a subscription that is not an observable', async () => {
    const t = trpc.initTRPC.create();
    const router = t.router({
      stream: t.procedure.subscription(async function* () {
        yield 1;
      }),
    });

    const { lastReply } = await run(router, { path: 'stream', type: 'subscription' });

    expect(lastReply()).toMatchObject({
      error: {
        message: 'Subscription stream did not return an observable',
        data: { code: 'INTERNAL_SERVER_ERROR' },
      },
    });
  });

  // Data replies are built without transformTRPCResponse for speed; they must stay identical to it.
  describe('data replies match transformTRPCResponse', () => {
    const upper = {
      serialize: (v: unknown) => `<${JSON.stringify(v)}>`,
      deserialize: (v: any) => JSON.parse(v.slice(1, -1)),
    };
    const transformers = {
      'no transformer': undefined,
      'one transformer for both directions': upper,
      'separate input and output': {
        input: { serialize: (v: unknown) => v, deserialize: (v: unknown) => v },
        output: upper,
      },
    };

    test.each(Object.entries(transformers))('%s', async (_name, transformer) => {
      const t = trpc.initTRPC.create(transformer ? { transformer } : {});
      const value = { nested: { list: [1, 'two', null], flag: false }, zero: 0, empty: '' };
      const router = t.router({
        query: t.procedure.query(() => value),
        nothing: t.procedure.query(() => undefined),
        stream: t.procedure.subscription(() =>
          observable<typeof value>((emit) => emit.next(value))
        ),
      });
      for (const [path, type, expected] of [
        ['query', 'query', value],
        ['nothing', 'query', undefined],
        ['stream', 'subscription', value],
      ] as const) {
        const { lastReply } = await run(router, { path, type });
        expect(lastReply()).toStrictEqual(
          trpc.transformTRPCResponse(router._def._config, {
            id: 1,
            result: { type: 'data', data: expected },
          })
        );
      }
    });
  });
});
