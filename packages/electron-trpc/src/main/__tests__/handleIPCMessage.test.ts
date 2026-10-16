import { describe, expect, MockedFunction, test, vi } from 'vitest';
import { z } from 'zod';
import * as trpc from '@trpc/server';
import { observable, type Unsubscribable } from '@trpc/server/observable';
import { EventEmitter } from 'events';
import { handleIPCMessage } from '../handleIPCMessage';
import { IpcMainEvent } from 'electron';

interface MockEvent {
  reply: MockedFunction<any>;
  sender: {
    isDestroyed: () => boolean;
    on: (event: string, cb: () => void) => void;
  };
}
const makeEvent = (event: MockEvent) => event as unknown as IpcMainEvent & Pick<MockEvent, 'reply'>;

const ee = new EventEmitter();

const t = trpc.initTRPC.create();
const testRouter = t.router({
  testQuery: t.procedure
    .input(
      z.object({
        id: z.string(),
      })
    )
    .query(({ input }) => {
      return { id: input.id, isTest: true };
    }),
  testSubscription: t.procedure.subscription(() => {
    return observable((emit) => {
      function testResponse() {
        emit.next('test response');
      }

      ee.on('test', testResponse);
      return () => ee.off('test', testResponse);
    });
  }),
});

describe('api', () => {
  test('handles queries', async () => {
    const event = makeEvent({
      reply: vi.fn(),
      sender: {
        isDestroyed: () => false,
        on: () => {},
      },
    });

    await handleIPCMessage({
      createContext: async () => ({}),
      event,
      internalId: '1-1:1',
      message: {
        method: 'request',
        operation: {
          context: {},
          id: 1,
          input: { id: 'test-id' },
          path: 'testQuery',
          type: 'query',
        },
      },
      router: testRouter,
      subscriptions: new Map(),
    });

    expect(event.reply).toHaveBeenCalledOnce();
    expect(event.reply.mock.lastCall![1]).toMatchObject({
      id: 1,
      result: {
        data: {
          id: 'test-id',
          isTest: true,
        },
      },
    });
  });

  test('does not respond if sender is gone', async () => {
    const event = makeEvent({
      reply: vi.fn(),
      sender: {
        isDestroyed: () => true,
        on: () => {},
      },
    });

    await handleIPCMessage({
      createContext: async () => ({}),
      event,
      internalId: '1-1:1',
      message: {
        method: 'request',
        operation: {
          context: {},
          id: 1,
          input: { id: 'test-id' },
          path: 'testQuery',
          type: 'query',
        },
      },
      router: testRouter,
      subscriptions: new Map(),
    });

    expect(event.reply).not.toHaveBeenCalled();
  });

  test('handles subscriptions', async () => {
    const event = makeEvent({
      reply: vi.fn(),
      sender: {
        isDestroyed: () => false,
        on: () => {},
      },
    });

    await handleIPCMessage({
      createContext: async () => ({}),
      message: {
        method: 'request',
        operation: {
          context: {},
          id: 1,
          input: undefined,
          path: 'testSubscription',
          type: 'subscription',
        },
      },
      internalId: '1-1:1',
      subscriptions: new Map(),
      router: testRouter,
      event,
    });

    expect(event.reply).not.toHaveBeenCalled();

    ee.emit('test');

    expect(event.reply).toHaveBeenCalledOnce();
    expect(event.reply.mock.lastCall![1]).toMatchObject({
      id: 1,
      result: {
        data: 'test response',
      },
    });
  });

  test('subscription responds using custom serializer', async () => {
    const event = makeEvent({
      reply: vi.fn(),
      sender: {
        isDestroyed: () => false,
        on: () => {},
      },
    });

    const t = trpc.initTRPC.create({
      transformer: {
        deserialize: (input: unknown) => {
          const serialized = (input as string).replace(/^serialized:/, '');
          return JSON.parse(serialized);
        },
        serialize: (input) => {
          return `serialized:${JSON.stringify(input)}`;
        },
      },
    });

    const testRouter = t.router({
      testSubscription: t.procedure.subscription(() => {
        return observable((emit) => {
          function testResponse() {
            emit.next('test response');
          }

          ee.on('test', testResponse);
          return () => ee.off('test', testResponse);
        });
      }),
    });

    await handleIPCMessage({
      createContext: async () => ({}),
      message: {
        method: 'request',
        operation: {
          context: {},
          id: 1,
          input: undefined,
          path: 'testSubscription',
          type: 'subscription',
        },
      },
      internalId: '1-1:1',
      subscriptions: new Map(),
      router: testRouter,
      event,
    });

    expect(event.reply).not.toHaveBeenCalled();

    ee.emit('test');

    expect(event.reply).toHaveBeenCalledOnce();
    expect(event.reply.mock.lastCall![1]).toMatchObject({
      id: 1,
      result: {
        type: 'data',
        data: 'serialized:"test response"',
      },
    });
  });

  async function subscribeToStream(router: trpc.AnyRouter, reply: MockedFunction<any> = vi.fn()) {
    const event = makeEvent({ reply, sender: { isDestroyed: () => false, on: () => {} } });
    const subscriptions = new Map<string, Unsubscribable>();
    await handleIPCMessage({
      event,
      internalId: '1:1:1',
      message: {
        method: 'request',
        operation: { context: {}, id: 1, input: undefined, path: 'stream', type: 'subscription' },
      },
      router,
      subscriptions,
    });
    return { event, subscriptions };
  }

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

    const { event, subscriptions } = await subscribeToStream(router);

    expect(event.reply.mock.lastCall![1]).toMatchObject({ result: { type: 'stopped' } });
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(subscriptions.size).toBe(0);
  });

  test('releases a stream whose replies can no longer be delivered', async () => {
    const source = new EventEmitter();
    const t = trpc.initTRPC.create();
    const router = t.router({
      stream: t.procedure.subscription(() =>
        observable((emit) => {
          const onTick = () => emit.next('tick');
          source.on('tick', onTick);
          return () => source.off('tick', onTick);
        })
      ),
    });
    const reply = vi.fn(() => {
      throw new Error('Frame was disposed');
    });

    const { subscriptions } = await subscribeToStream(router, reply);
    source.emit('tick');

    expect(source.listenerCount('tick')).toBe(0);
    expect(subscriptions.size).toBe(0);
  });

  test('stops replying once a subscription is stopped, even if its source keeps emitting', async () => {
    const source = new EventEmitter();
    const t = trpc.initTRPC.create();
    const router = t.router({
      stream: t.procedure.subscription(() =>
        observable((emit) => {
          source.on('tick', () => emit.next('tick'));
          return () => {}; // teardown that does not detach the source
        })
      ),
    });

    const { event, subscriptions } = await subscribeToStream(router);
    subscriptions.get('1:1:1')!.unsubscribe();
    source.emit('tick');

    expect(event.reply).not.toHaveBeenCalled();
    expect(subscriptions.size).toBe(0);
  });

  test('reports a thrown non-Error value as an internal error', async () => {
    const event = makeEvent({ reply: vi.fn(), sender: { isDestroyed: () => false, on: () => {} } });

    await handleIPCMessage({
      createContext: async () => {
        throw { reason: 'not an Error' };
      },
      event,
      internalId: '1:1:1',
      message: {
        method: 'request',
        operation: { context: {}, id: 1, input: { id: 'x' }, path: 'testQuery', type: 'query' },
      },
      router: testRouter,
      subscriptions: new Map(),
    });

    expect(event.reply).toHaveBeenCalledOnce();
    expect(event.reply.mock.lastCall![1]).toMatchObject({
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

    const { event } = await subscribeToStream(router);

    expect(event.reply.mock.lastCall![1]).toMatchObject({
      error: {
        message: 'Subscription stream did not return an observable',
        data: { code: 'INTERNAL_SERVER_ERROR' },
      },
    });
  });
});
