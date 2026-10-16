import { createTRPCClient } from '@trpc/client';
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { EventEmitter } from 'node:events';
import superjson from 'superjson';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ELECTRON_TRPC_CHANNEL } from '../constants';
import { createIPCHandler } from '../main/createIPCHandler';
import { windowFixture } from '../main/__tests__/windowFixture';
import { ipcLink, MessageRouter } from '../renderer/ipcLink';
import type { RendererGlobalElectronTRPC } from '../types';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter() };
});
const { ipcMain } = await import('electron');

// A real handler and a real link joined by a bridge that structured-clones everything it carries,
// as Electron does, and records what kind of value crossed it in each direction.
function connect(router: ReturnType<typeof makeRouter>) {
  const { win, event: messageEvent } = windowFixture(1);
  const crossed: { toMain: string[]; toRenderer: string[] } = { toMain: [], toRenderer: [] };
  type Listener = Parameters<RendererGlobalElectronTRPC['onMessage']>[0];
  let listener: Listener | undefined;
  const event = {
    ...messageEvent,
    reply: (_channel: string, reply: unknown) => {
      crossed.toRenderer.push(typeof reply);
      const copy = structuredClone(reply);
      queueMicrotask(() => listener?.(copy as Parameters<Listener>[0]));
    },
  };
  vi.stubGlobal('electronTRPC', {
    sendMessage: (message: unknown) => {
      crossed.toMain.push(typeof message);
      const copy = structuredClone(message);
      queueMicrotask(() => ipcMain.emit(ELECTRON_TRPC_CHANNEL, event, copy));
    },
    onMessage: (callback: Listener) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  } satisfies RendererGlobalElectronTRPC);
  const handler = createIPCHandler({ router, windows: [win] });
  return { handler, crossed };
}

const t = initTRPC.create({ transformer: superjson });
const source = new EventEmitter();
function makeRouter() {
  return t.router({
    echo: t.procedure.input((value: unknown) => value).query(({ input }) => input),
    fail: t.procedure.query(() => {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not allowed' });
    }),
    ticks: t.procedure.subscription(() =>
      observable<Date>((emit) => {
        const onTick = (date: Date) => emit.next(date);
        source.on('tick', onTick);
        return () => source.off('tick', onTick);
      })
    ),
  });
}
const plain = initTRPC.create();
const plainRouter = plain.router({
  echo: plain.procedure.input((value: unknown) => value).query(({ input }) => input),
});

let handler: { dispose(): void } | undefined;
afterEach(() => {
  handler?.dispose();
  handler = undefined;
  MessageRouter.reset();
  vi.unstubAllGlobals();
});

describe('json wire format', () => {
  test('round-trips rich values through superjson, as text in both directions', async () => {
    const bridge = connect(makeRouter());
    handler = bridge.handler;
    const client = createTRPCClient<ReturnType<typeof makeRouter>>({
      links: [ipcLink({ transformer: superjson, wireFormat: 'json' })],
    });
    const value = {
      when: new Date('2026-01-01T00:00:00Z'),
      big: 2n ** 70n,
      map: new Map([['a', { n: 1 }]]),
      missing: undefined,
      zero: 0,
      nothing: null,
      list: Array.from({ length: 50 }, (_, id) => ({ id, name: `node ${id}` })),
    };
    expect(await client.echo.query(value)).toStrictEqual(value);
    expect(bridge.crossed).toEqual({ toMain: ['string'], toRenderer: ['string'] });
  });

  test('delivers errors and subscription events as text', async () => {
    const bridge = connect(makeRouter());
    handler = bridge.handler;
    const client = createTRPCClient<ReturnType<typeof makeRouter>>({
      links: [ipcLink({ transformer: superjson, wireFormat: 'json' })],
    });
    await expect(client.fail.query()).rejects.toMatchObject({
      message: 'Not allowed',
      data: { code: 'FORBIDDEN' },
    });

    const received: Date[] = [];
    const subscription = client.ticks.subscribe(undefined, {
      onData: (date) => received.push(date),
    });
    await vi.waitFor(() => expect(source.listenerCount('tick')).toBe(1));
    const date = new Date('2026-02-03T04:05:06Z');
    source.emit('tick', date);
    await vi.waitFor(() => expect(received).toEqual([date]));
    subscription.unsubscribe();
    await vi.waitFor(() => expect(source.listenerCount('tick')).toBe(0));
    expect(new Set([...bridge.crossed.toMain, ...bridge.crossed.toRenderer])).toEqual(
      new Set(['string'])
    );
  });

  test('without a transformer only JSON values survive, as documented', async () => {
    const bridge = connect(plainRouter as never);
    handler = bridge.handler;
    const client = createTRPCClient<typeof plainRouter>({
      links: [ipcLink({ wireFormat: 'json' })],
    });
    const when = new Date('2026-01-01T00:00:00Z');
    expect(await client.echo.query({ when, gone: undefined, zero: 0 })).toEqual({
      when: when.toISOString(),
      zero: 0,
    });
  });

  test('the default wire format keeps exchanging objects and rich values', async () => {
    const bridge = connect(plainRouter as never);
    handler = bridge.handler;
    const client = createTRPCClient<typeof plainRouter>({ links: [ipcLink()] });
    const value = { when: new Date('2026-01-01T00:00:00Z'), bytes: new Uint8Array([1, 2, 3]) };
    expect(await client.echo.query(value)).toEqual(value);
    expect(bridge.crossed).toEqual({ toMain: ['object'], toRenderer: ['object'] });
  });
});
