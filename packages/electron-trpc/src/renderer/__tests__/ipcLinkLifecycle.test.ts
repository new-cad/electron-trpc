import { createTRPCClient } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import type { TRPCResponseMessage } from '@trpc/server/rpc';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { RendererGlobalElectronTRPC } from '../../types';
import { ipcLink, MessageRouter } from '../ipcLink';

const t = initTRPC.create();
const router = t.router({
  read: t.procedure.query(() => 'ok'),
  stream: t.procedure.subscription(() => observable<number>(() => {})),
});
const send = vi.fn<RendererGlobalElectronTRPC['sendMessage']>();
const remove = vi.fn();
const listen = vi.fn<RendererGlobalElectronTRPC['onMessage']>();
let receive: (response: TRPCResponseMessage) => void;
beforeEach(() => {
  vi.clearAllMocks();
  send.mockReset();
  listen.mockImplementation((callback) => {
    receive = callback;
    return remove;
  });
  vi.stubGlobal('electronTRPC', {
    onMessage: listen,
    sendMessage: send,
  } satisfies RendererGlobalElectronTRPC);
});
afterEach(() => {
  MessageRouter.reset();
  vi.unstubAllGlobals();
});
const makeClient = () => createTRPCClient<typeof router>({ links: [ipcLink()] });
function requestId(index = send.mock.calls.length - 1) {
  const message = send.mock.calls[index][0];
  if (message.method !== 'request') throw new Error('Expected a request');
  return message.operation.id;
}

test('releases inactive clients and bridge listeners after repeated queries', async () => {
  const client = makeClient();
  expect(listen).not.toHaveBeenCalled();
  for (let index = 0; index < 100; index++) {
    const result = client.read.query();
    receive({ id: requestId(), result: { type: 'data', data: 'ok' } });
    await expect(result).resolves.toBe('ok');
  }
  expect(listen).toHaveBeenCalledTimes(100);
  expect(remove).toHaveBeenCalledTimes(100);
});

test('shares one listener across active clients and removes it only after the last response', async () => {
  const first = makeClient().read.query();
  const second = makeClient().read.query();
  expect(listen).toHaveBeenCalledOnce();
  receive({ id: requestId(0), result: { type: 'data', data: 'one' } });
  await expect(first).resolves.toBe('one');
  expect(remove).not.toHaveBeenCalled();
  receive({ id: requestId(1), result: { type: 'data', data: 'two' } });
  await expect(second).resolves.toBe('two');
  expect(remove).toHaveBeenCalledOnce();
});

test('stops a subscription once even if it is unsubscribed repeatedly', () => {
  const complete = vi.fn();
  const subscription = makeClient().stream.subscribe(undefined, { onComplete: complete });
  subscription.unsubscribe();
  subscription.unsubscribe();
  expect(
    send.mock.calls.filter(([message]) => message.method === 'subscription.stop')
  ).toHaveLength(1);
  expect(complete).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
});

test('server completion releases a subscription without sending another stop message', () => {
  const complete = vi.fn();
  const subscription = makeClient().stream.subscribe(undefined, { onComplete: complete });
  receive({ id: requestId(), result: { type: 'stopped' } });
  subscription.unsubscribe();
  expect(send).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledOnce();
  expect(remove).toHaveBeenCalledOnce();
});

test('aborting a live subscription stops it on the server exactly once', () => {
  const controller = new AbortController();
  makeClient().stream.subscribe(undefined, { signal: controller.signal, onError: vi.fn() });
  controller.abort();
  controller.abort();
  expect(
    send.mock.calls.filter(([message]) => message.method === 'subscription.stop')
  ).toHaveLength(1);
  expect(remove).toHaveBeenCalledOnce();
});

// Older preloads returned nothing, or the emitter returned by `ipcRenderer.on`.
test.each([undefined, {}])(
  'a bridge without a disposer (%j) is registered once',
  async (legacy) => {
    listen.mockImplementation((callback) => {
      receive = callback;
      return legacy as never;
    });
    const client = makeClient();
    for (let index = 0; index < 3; index++) {
      const result = client.read.query();
      receive({ id: requestId(), result: { type: 'data', data: 'ok' } });
      await expect(result).resolves.toBe('ok');
    }
    expect(listen).toHaveBeenCalledOnce();
  }
);

test('client ids differ between documents, so a late reply cannot reach a new document', async () => {
  // Every document starts counting clients from 1; the per-document token keeps the ids apart.
  const ids: string[] = [];
  for (let document = 0; document < 2; document++) {
    vi.resetModules();
    const { ipcLink: documentLink, MessageRouter: documentRouter } = await import('../ipcLink');
    void createTRPCClient<typeof router>({ links: [documentLink()] }).read.query();
    ids.push(String(requestId()));
    documentRouter.reset();
  }
  expect(ids[0]).not.toBe(ids[1]);
});

test('ignores a reply addressed to a client of another document', async () => {
  const result = makeClient().read.query();
  const id = String(requestId());
  receive({ id: id.replace(/-[^:]+:/, '-other:'), result: { type: 'data', data: 'stale' } });
  expect(remove).not.toHaveBeenCalled();
  receive({ id, result: { type: 'data', data: 'fresh' } });
  await expect(result).resolves.toBe('fresh');
});

test('does not send an already aborted request', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    makeClient().read.query(undefined, { signal: controller.signal })
  ).rejects.toMatchObject({ cause: { name: 'AbortError' } });
  expect(send).not.toHaveBeenCalled();
  expect(listen).not.toHaveBeenCalled();
});

test('aborts pending requests without putting AbortSignal objects into IPC payloads', async () => {
  const controller = new AbortController();
  const result = makeClient().read.query(undefined, { signal: controller.signal });
  const packet = send.mock.calls[0][0];
  expect(packet).toHaveProperty('operation');
  if (packet.method === 'request') expect(packet.operation).not.toHaveProperty('signal');
  controller.abort();
  await expect(result).rejects.toMatchObject({ cause: { name: 'AbortError' } });
  expect(remove).toHaveBeenCalledOnce();
});

test('a send failure rejects the request and releases its listener', async () => {
  send.mockImplementation(() => {
    throw new Error('Cannot clone payload');
  });
  await expect(makeClient().read.query()).rejects.toThrow('Cannot clone payload');
  expect(remove).toHaveBeenCalledOnce();
});

test('a failing output transformer rejects and releases the request', async () => {
  const client = createTRPCClient<typeof router>({
    links: [
      ipcLink({
        transformer: {
          serialize: (value) => value,
          deserialize: () => {
            throw new Error('Invalid response');
          },
        },
      }),
    ],
  });
  const result = client.read.query();
  expect(() => receive({ id: requestId(), result: { type: 'data', data: 'bad' } })).not.toThrow();
  await expect(result).rejects.toThrow('Invalid response');
  expect(remove).toHaveBeenCalledOnce();
});

test('a failing input transformer reports subscription errors without sending or listening', () => {
  const client = createTRPCClient<typeof router>({
    links: [
      ipcLink({
        transformer: {
          serialize: () => {
            throw new Error('Invalid input');
          },
          deserialize: (value) => value,
        },
      }),
    ],
  });
  const onError = vi.fn();
  expect(() => client.stream.subscribe(undefined, { onError })).not.toThrow();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid input' }));
  expect(send).not.toHaveBeenCalled();
  expect(listen).not.toHaveBeenCalled();
});
