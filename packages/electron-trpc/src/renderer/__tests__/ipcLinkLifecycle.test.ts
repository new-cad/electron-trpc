import { createTRPCClient } from '@trpc/client';
import { initTRPC } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import type { TRPCResponseMessage } from '@trpc/server/rpc';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ETRPCRequest, RendererGlobalElectronTRPC } from '../../types';
import { ipcLink, MessageRouter } from '../ipcLink';

const t = initTRPC.create();
const router = t.router({
  read: t.procedure.query(() => 'ok'),
  stream: t.procedure.subscription(() => observable<number>(() => {})),
});
const send = vi.fn<RendererGlobalElectronTRPC['sendMessage']>();
const remove = vi.fn();
const listen = vi.fn<RendererGlobalElectronTRPC['onMessage']>();
let receive: (response: TRPCResponseMessage | string) => void;
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
const makeClient = (options?: Parameters<typeof ipcLink>[0]) =>
  createTRPCClient<typeof router>({ links: [ipcLink(options)] });
const makeJsonClient = () => makeClient({ wireFormat: 'json' });
// Messages sent over the bridge, decoded when the link used the `json` wire format.
const sent = (index: number): ETRPCRequest => {
  const message = send.mock.calls[index][0];
  return typeof message === 'string' ? JSON.parse(message) : message;
};
const sentMessages = () => send.mock.calls.map((_call, index) => sent(index));
function requestId(index = send.mock.calls.length - 1) {
  const message = sent(index);
  if (message.method !== 'request') throw new Error('Expected a request');
  return message.operation.id;
}
// A successful reply to the request sent at `index` (the latest by default).
const reply = (data: unknown, index?: number) => ({
  id: requestId(index),
  result: { type: 'data' as const, data },
});

test('releases inactive clients and bridge listeners after repeated queries', async () => {
  const client = makeClient();
  expect(listen).not.toHaveBeenCalled();
  for (let index = 0; index < 100; index++) {
    const result = client.read.query();
    receive(reply('ok'));
    await expect(result).resolves.toBe('ok');
  }
  expect(listen).toHaveBeenCalledTimes(100);
  expect(remove).toHaveBeenCalledTimes(100);
});

test('shares one listener across active clients and removes it only after the last response', async () => {
  const first = makeClient().read.query();
  const second = makeClient().read.query();
  expect(listen).toHaveBeenCalledOnce();
  receive(reply('one', 0));
  await expect(first).resolves.toBe('one');
  expect(remove).not.toHaveBeenCalled();
  receive(reply('two', 1));
  await expect(second).resolves.toBe('two');
  expect(remove).toHaveBeenCalledOnce();
});

test('stops a subscription once even if it is unsubscribed repeatedly', () => {
  const complete = vi.fn();
  const subscription = makeClient().stream.subscribe(undefined, { onComplete: complete });
  subscription.unsubscribe();
  subscription.unsubscribe();
  expect(sentMessages().filter((message) => message.method === 'subscription.stop')).toHaveLength(
    1
  );
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
  expect(sentMessages().filter((message) => message.method === 'subscription.stop')).toHaveLength(
    1
  );
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
      receive(reply('ok'));
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
  receive({ ...reply('stale'), id: id.replace(/-[^:]+:/, '-other:') });
  expect(remove).not.toHaveBeenCalled();
  receive(reply('fresh'));
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
  const packet = sent(0);
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
  const client = makeClient({
    transformer: {
      serialize: (value) => value,
      deserialize: () => {
        throw new Error('Invalid response');
      },
    },
  });
  const result = client.read.query();
  expect(() => receive(reply('bad'))).not.toThrow();
  await expect(result).rejects.toThrow('Invalid response');
  expect(remove).toHaveBeenCalledOnce();
});

test('a failing input transformer reports subscription errors without sending or listening', () => {
  const client = makeClient({
    transformer: {
      serialize: () => {
        throw new Error('Invalid input');
      },
      deserialize: (value) => value,
    },
  });
  const onError = vi.fn();
  expect(() => client.stream.subscribe(undefined, { onError })).not.toThrow();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Invalid input' }));
  expect(send).not.toHaveBeenCalled();
  expect(listen).not.toHaveBeenCalled();
});

test('the json wire format sends requests and stop messages as text', () => {
  const subscription = makeJsonClient().stream.subscribe(undefined, { onError: vi.fn() });
  expect(typeof send.mock.calls[0][0]).toBe('string');
  expect(sent(0)).toMatchObject({
    method: 'request',
    operation: { type: 'subscription', path: 'stream' },
  });
  subscription.unsubscribe();
  expect(typeof send.mock.calls[1][0]).toBe('string');
  expect(sent(1)).toEqual({ method: 'subscription.stop', id: requestId(0) });
});

test('links with different wire formats share one bridge', async () => {
  const text = makeJsonClient().read.query();
  const objects = makeClient().read.query();
  expect(typeof send.mock.calls[0][0]).toBe('string');
  expect(typeof send.mock.calls[1][0]).toBe('object');
  receive(JSON.stringify(reply('from text', 0)));
  receive(reply('from object', 1));
  await expect(text).resolves.toBe('from text');
  await expect(objects).resolves.toBe('from object');
  expect(listen).toHaveBeenCalledOnce();
});

test('ignores an undecodable text reply and keeps waiting for the real one', async () => {
  const result = makeJsonClient().read.query();
  expect(() => receive('{not json')).not.toThrow();
  expect(remove).not.toHaveBeenCalled();
  receive(JSON.stringify(reply('ok')));
  await expect(result).resolves.toBe('ok');
});

test('the per-call context is not sent, so an unencodable one cannot fail a json call', async () => {
  const context: Record<string, unknown> = { amount: 10n };
  context.self = context;
  const result = makeJsonClient().read.query(undefined, { context });
  expect(sent(0)).not.toHaveProperty('operation.context');
  receive(JSON.stringify(reply('ok')));
  await expect(result).resolves.toBe('ok');
});

test('a json request that cannot be encoded rejects and releases the client', async () => {
  const client = makeJsonClient() as unknown as {
    read: { query(input: unknown): Promise<unknown> };
  };
  await expect(client.read.query(10n)).rejects.toThrow(/BigInt/);
  expect(send).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
});
