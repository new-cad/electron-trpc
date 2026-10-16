import { initTRPC } from '@trpc/server';
import { observable, type Observer } from '@trpc/server/observable';
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ELECTRON_TRPC_CHANNEL } from '../../constants';
import { createIPCHandler } from '../createIPCHandler';
import { windowFixture } from './windowFixture';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter() };
});

const handlers: { dispose(): void }[] = [];
afterEach(() => {
  handlers.splice(0).forEach((handler) => handler.dispose());
});
function track<T extends { dispose(): void }>(handler: T) {
  handlers.push(handler);
  return handler;
}
// A message sent by a subframe of the fixture window: its ids are consistent, only it is not the
// main frame.
const fromSubframe = (event: IpcMainEvent) => ({
  ...event,
  senderFrame: { processId: 7, routingId: 10 },
  frameId: 10,
});

const send = (event: unknown, message: unknown) =>
  ipcMain.emit(ELECTRON_TRPC_CHANNEL, event, message);
const request = (id = 'c1:1', type = 'query', path = 'read') => ({
  method: 'request',
  operation: { id, type, path },
});
const text = (message: unknown) => JSON.stringify(message);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}
const emptyRouter = () => initTRPC.create().router({});

// A tracked handler with a fresh window attached; the router is empty unless given.
function attach(options: Partial<Parameters<typeof createIPCHandler>[0]> = {}) {
  const target = windowFixture(1);
  const handler = track(
    createIPCHandler({ router: emptyRouter(), windows: [target.win], ...options })
  );
  return { ...target, handler };
}

// A router with one subscription that the test drives by hand.
function streamRouter() {
  const resolved = vi.fn();
  const subscribed = vi.fn();
  const cleanup = vi.fn();
  let observer!: Observer<unknown, unknown>;
  const t = initTRPC.create();
  const router = t.router({
    stream: t.procedure.subscription(() => {
      resolved();
      return observable<unknown>((o) => {
        observer = o;
        subscribed();
        return cleanup;
      });
    }),
  });
  return {
    router,
    resolved,
    subscribed,
    cleanup,
    emit: (value: unknown) => observer.next(value),
    complete: () => observer.complete(),
  };
}

// A query that stays in flight until `release` is called.
function gatedQuery() {
  const gate = deferred<void>();
  const started = vi.fn();
  const t = initTRPC.create();
  const router = t.router({
    read: t.procedure.query(async () => {
      started();
      await gate.promise;
      return 'late';
    }),
  });
  return { router, release: gate.resolve, started };
}

// Every way access to a document can end while work for it is still pending.
const revocations = ['navigation', 'error page', 'crash', 'detach', 'dispose'] as const;
function revoke(action: (typeof revocations)[number], target: ReturnType<typeof attach>) {
  if (action === 'navigation') target.contents.emit('did-navigate');
  if (action === 'error page') {
    // A failed load puts Chromium's error page in a new main frame and emits only `did-fail-load`.
    Object.assign(target.contents, {
      mainFrame: { processId: 8, routingId: 1, url: 'chrome-error://x/' },
    });
    target.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x/', true);
  }
  if (action === 'crash') target.contents.emit('render-process-gone');
  if (action === 'detach') target.handler.detachWindow(target.win);
  if (action === 'dispose') target.handler.dispose();
}

describe('IPC sender boundary', () => {
  test('only attached main frames may execute a procedure', async () => {
    const read = vi.fn(() => 'ok');
    const t = initTRPC.create();
    const allowed = attach({ router: t.router({ read: t.procedure.query(read) }) });
    send(windowFixture(2).event, request());
    send(fromSubframe(allowed.event), request());
    send({ ...allowed.event, senderFrame: null }, request());
    await flush();
    expect(read).not.toHaveBeenCalled();
    send(allowed.event, request());
    await vi.waitFor(() => expect(allowed.reply).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledOnce();
  });

  test.each([{ processId: 99 }, { frameId: 99 }])(
    'rejects a message whose recorded sender ids are not the current main frame: %j',
    async (ids) => {
      // `senderFrame` resolves lazily, so it can point at the current main frame even though the
      // message was sent by a document that has since been replaced.
      const createContext = vi.fn();
      const target = attach({ createContext });
      send({ ...target.event, ...ids }, request());
      await flush();
      expect(createContext).not.toHaveBeenCalled();
      send(target.event, request());
      await vi.waitFor(() => expect(createContext).toHaveBeenCalledOnce());
    }
  );

  test('an empty window list denies every sender', async () => {
    const createContext = vi.fn();
    track(createIPCHandler({ router: emptyRouter(), createContext }));
    send(windowFixture(1).event, request());
    await flush();
    expect(createContext).not.toHaveBeenCalled();
  });

  test('serves senders accepted by the application policy', async () => {
    const validateSender = vi.fn(() => true);
    const t = initTRPC.create();
    const target = attach({
      router: t.router({ read: t.procedure.query(() => 'ok') }),
      validateSender,
    });
    send(target.event, request());
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    expect(validateSender).toHaveBeenCalledWith(target.event);
  });

  test.each([undefined, 1, 'yes', {}, Promise.resolve(true)])(
    'requires the application policy to return exactly true: %s',
    async (verdict) => {
      const createContext = vi.fn();
      const target = attach({
        createContext,
        validateSender: (() => verdict) as unknown as () => boolean,
      });
      send(target.event, request());
      await flush();
      expect(createContext).not.toHaveBeenCalled();
    }
  );

  test('fails closed if the application policy throws', async () => {
    const createContext = vi.fn();
    const validateSender = vi.fn(() => {
      throw new Error('Policy failed');
    });
    const target = attach({ createContext, validateSender });
    expect(() => send(target.event, request())).not.toThrow();
    await flush();
    expect(validateSender).toHaveBeenCalledOnce();
    expect(createContext).not.toHaveBeenCalled();
  });

  test.each([
    null,
    [],
    {},
    { method: 'request' },
    { method: 'subscription.stop', id: {} },
    request('', 'query'),
    request('c1:1', 'other'),
    request('c1:1', 'query', ''),
    { method: 'request', operation: { id: {}, type: 'query', path: 'read' } },
    { method: 'request', operation: { id: 1, type: 'query', path: 123 } },
    ...[-1, 1.5, Number.NaN, 2 ** 53].map((id) => ({
      method: 'request',
      operation: { id, type: 'query', path: 'read' },
    })),
  ])('drops malformed wire messages: %j', async (message) => {
    const createContext = vi.fn();
    const target = attach({ createContext });
    expect(() => send(target.event, message)).not.toThrow();
    await flush();
    expect(createContext).not.toHaveBeenCalled();
    expect(target.reply).not.toHaveBeenCalled();
  });

  test('ignores a destroyed webContents without reading its native properties', () => {
    const createContext = vi.fn();
    const target = attach({ createContext });
    Object.defineProperty(target.contents, 'isDestroyed', { value: () => true });
    Object.defineProperty(target.contents, 'mainFrame', {
      get: () => {
        throw new Error('Object has been destroyed');
      },
    });
    expect(() => send(target.event, request())).not.toThrow();
    expect(createContext).not.toHaveBeenCalled();
  });

  test('accepts numeric request ids, including 0', async () => {
    const t = initTRPC.create();
    const target = attach({ router: t.router({ read: t.procedure.query(() => 'ok') }) });
    send(target.event, { method: 'request', operation: { id: 0, type: 'query', path: 'read' } });
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    expect(target.reply.mock.calls[0][1]).toMatchObject({ id: 0, result: { data: 'ok' } });
  });

  test('formats a context failure instead of rejecting the IPC listener', async () => {
    const target = attach({
      createContext: async () => {
        throw new Error('Context failed');
      },
    });
    send(target.event, request());
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    expect(target.reply.mock.calls[0][1]).toMatchObject({
      error: { message: 'Context failed', data: { code: 'INTERNAL_SERVER_ERROR' } },
    });
  });
});

describe('handler lifecycle', () => {
  test('rolls back attached listeners if a later constructor window is destroyed', () => {
    const target = windowFixture(1);
    const destroyed = { isDestroyed: () => true } as unknown as BrowserWindow;
    expect(() =>
      createIPCHandler({ router: emptyRouter(), windows: [target.win, destroyed] })
    ).toThrow('destroyed');
    expect(target.contents.eventNames()).toEqual([]);
    expect(ipcMain.listenerCount(ELECTRON_TRPC_CHANNEL)).toBe(0);
  });

  test('cleans a destroyed WebContents without reading its destroyed native properties', () => {
    const target = attach();
    Object.defineProperty(target.contents, 'id', {
      get: () => {
        throw new Error('Object has been destroyed');
      },
    });
    expect(() => target.contents.emit('destroyed')).not.toThrow();
    expect(target.contents.eventNames()).toEqual([]);
  });

  test('a duplicate subscription ID cannot overwrite and leak the original stream', async () => {
    const stream = streamRouter();
    const target = attach({ router: stream.router });
    send(target.event, request('c1:1', 'subscription', 'stream'));
    await vi.waitFor(() => expect(stream.subscribed).toHaveBeenCalledOnce());
    send(target.event, request('c1:1', 'subscription', 'stream'));
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    expect(stream.cleanup).toHaveBeenCalledOnce();
    expect(stream.resolved).toHaveBeenCalledOnce();
    expect(target.reply.mock.calls[0][1]).toMatchObject({ error: { data: { code: 'CONFLICT' } } });
  });

  test('cancels while an asynchronous subscription resolver is still pending', async () => {
    const stream = deferred<ReturnType<typeof observable>>();
    const started = vi.fn();
    const t = initTRPC.create();
    const target = attach({
      router: t.router({
        stream: t.procedure.subscription(() => {
          started();
          return stream.promise;
        }),
      }),
    });
    send(target.event, request('c1:1', 'subscription', 'stream'));
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    send(target.event, { method: 'subscription.stop', id: 'c1:1' });
    const subscribe = vi.fn();
    stream.resolve(observable(subscribe));
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(target.reply).not.toHaveBeenCalled();
  });

  test('detaches all listeners and can be disposed repeatedly', () => {
    const target = attach();
    target.handler.attachWindow(target.win);
    expect(target.contents.listenerCount('did-navigate')).toBe(1);
    target.handler.detachWindow(target.win);
    expect(target.contents.eventNames()).toEqual([]);
    target.handler.attachWindow(target.win);
    target.handler.dispose();
    target.handler.dispose();
    expect(target.contents.eventNames()).toEqual([]);
    expect(ipcMain.listenerCount(ELECTRON_TRPC_CHANNEL)).toBe(0);
    expect(() => target.handler.attachWindow(target.win)).toThrow('disposed');
  });

  test.each(['stop', ...revocations] as const)(
    'cancels a subscription during asynchronous context creation: %s',
    async (action) => {
      const context = deferred<object>();
      const stream = streamRouter();
      const target = attach({ router: stream.router, createContext: () => context.promise });
      send(target.event, request('c1:1', 'subscription', 'stream'));
      if (action === 'stop') send(target.event, { method: 'subscription.stop', id: 'c1:1' });
      else revoke(action, target);
      context.resolve({});
      await flush();
      expect(stream.resolved).not.toHaveBeenCalled();
      expect(target.reply).not.toHaveBeenCalled();
    }
  );

  test.each(revocations)(
    'drops the reply of a query that is in flight when access is revoked: %s',
    async (action) => {
      const { router, release, started } = gatedQuery();
      const target = attach({ router });
      send(target.event, request());
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
      revoke(action, target);
      release();
      await flush();
      expect(target.reply).not.toHaveBeenCalled();
    }
  );

  // Queries and mutations have no `subscriptions` entry, so only the authorization check after
  // `createContext` stops them from running for a document that no longer has access.
  test.each(revocations)(
    'a mutation whose context is still loading never runs once access is revoked: %s',
    async (action) => {
      const context = deferred<object>();
      const write = vi.fn(() => 'done');
      const t = initTRPC.create();
      const target = attach({
        router: t.router({ write: t.procedure.mutation(write) }),
        createContext: () => context.promise,
      });
      send(target.event, request('c1:1', 'mutation', 'write'));
      revoke(action, target);
      context.resolve({});
      await flush();
      expect(write).not.toHaveBeenCalled();
      expect(target.reply).not.toHaveBeenCalled();
    }
  );

  test('navigations that keep the document do not revoke work in flight', async () => {
    // Downloads, 204 responses and navigations cancelled in `will-navigate` all emit
    // `did-start-navigation` without replacing the document (the Electron smoke test covers the
    // last one). Subframe events and aborted loads do not replace the main-frame document either.
    const { router, release, started } = gatedQuery();
    const target = attach({ router });
    send(target.event, request());
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    target.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    target.contents.emit('did-navigate-in-page');
    target.contents.emit('did-frame-navigate', {}, 'app://x/f', 200, 'OK', false, 2, 3);
    // These failures leave the main frame, and therefore the document, in place.
    target.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x/', false);
    target.contents.emit('did-fail-load', {}, -300, 'ERR_INVALID_URL', 'http://[bad', true);
    target.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://x/', true);
    release();
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    expect(target.reply.mock.calls[0][1]).toMatchObject({ result: { data: 'late' } });
  });

  test('a load failure after the commit does not revoke the new document', async () => {
    // A truncated body emits `did-navigate` and then `did-fail-load` for the same document.
    const { router, release, started } = gatedQuery();
    const target = attach({ router });
    const replacement = { processId: 7, routingId: 2, url: 'app://trusted/next.html' };
    Object.assign(target.contents, { mainFrame: replacement });
    target.contents.emit('did-navigate');
    send({ ...target.event, senderFrame: replacement, frameId: replacement.routingId }, request());
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    target.contents.emit(
      'did-fail-load',
      {},
      -354,
      'ERR_CONTENT_LENGTH_MISMATCH',
      'http://x/',
      true
    );
    release();
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
  });

  test.each([
    { processId: 8, routingId: 1 },
    { processId: 7, routingId: 2 },
  ])('a failed load revokes when the main frame id changes: %j', async (replacement) => {
    const stream = streamRouter();
    const target = attach({ router: stream.router });
    send(target.event, request('c1:1', 'subscription', 'stream'));
    await flush();
    Object.assign(target.contents, { mainFrame: { ...replacement, url: 'chrome-error://x/' } });
    target.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x/', true);
    expect(stream.cleanup).toHaveBeenCalledOnce();
  });

  test('copes with a main frame that cannot be read after the renderer is gone', async () => {
    const unreadable = {
      get: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    };
    const crashed = windowFixture(1);
    Object.defineProperty(crashed.contents, 'mainFrame', unreadable);
    expect(() =>
      track(createIPCHandler({ router: emptyRouter(), windows: [crashed.win] }))
    ).not.toThrow();

    const stream = streamRouter();
    const live = attach({ router: stream.router });
    send(live.event, request('c1:1', 'subscription', 'stream'));
    await flush();
    Object.defineProperty(live.contents, 'mainFrame', unreadable);
    expect(() => live.contents.emit('did-navigate')).not.toThrow();
    expect(stream.cleanup).toHaveBeenCalledOnce();
    expect(() =>
      live.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x/', true)
    ).not.toThrow();
  });

  test('ignores detachWindow for a window that is not attached', () => {
    const attached = attach();
    expect(() => attached.handler.detachWindow(windowFixture(2).win)).not.toThrow();
    expect(attached.contents.listenerCount('did-navigate')).toBe(1);
  });

  test('stops serving a window once it is detached or destroyed', async () => {
    const stream = streamRouter();
    const createContext = vi.fn(() => ({}));
    const detached = windowFixture(1);
    const destroyed = windowFixture(2);
    const handler = track(
      createIPCHandler({
        router: stream.router,
        windows: [detached.win, destroyed.win],
        createContext,
      })
    );
    send(destroyed.event, request('c1:1', 'subscription', 'stream'));
    await vi.waitFor(() => expect(stream.subscribed).toHaveBeenCalledOnce());
    destroyed.contents.emit('destroyed');
    expect(stream.cleanup).toHaveBeenCalledOnce();

    handler.detachWindow(detached.win);
    createContext.mockClear();
    send(detached.event, request('c1:2', 'subscription', 'stream'));
    send(destroyed.event, request('c1:3', 'subscription', 'stream'));
    await flush();
    expect(createContext).not.toHaveBeenCalled();
  });

  test('refuses to detach a window under a different webContents id', () => {
    const target = attach();
    expect(() => target.handler.detachWindow(target.win, 2)).toThrow('does not match');
    expect(target.contents.listenerCount('did-navigate')).toBe(1);
    expect(target.contents.listenerCount('did-fail-load')).toBe(1);
  });

  test('navigation cleans only the matching window', async () => {
    const stream = streamRouter();
    const first = windowFixture(1);
    const second = windowFixture(10);
    track(createIPCHandler({ router: stream.router, windows: [first.win, second.win] }));
    send(first.event, request('c1:1', 'subscription', 'stream'));
    send(second.event, request('c1:1', 'subscription', 'stream'));
    await flush();
    first.contents.emit('did-navigate');
    expect(stream.cleanup).toHaveBeenCalledTimes(1);
    second.contents.emit('render-process-gone');
    expect(stream.cleanup).toHaveBeenCalledTimes(2);
  });
});

describe('json wire format', () => {
  const query = () => {
    const t = initTRPC.create();
    return t.router({
      read: t.procedure.query(() => ({ answer: 42 })),
      big: t.procedure.query(() => 10n),
    });
  };

  test('answers a text request with text and an object request with an object', async () => {
    const target = attach({ router: query() });
    send(target.event, text(request('c1:1')));
    send(target.event, request('c1:2'));
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledTimes(2));
    const [first, second] = target.reply.mock.calls.map(([, reply]) => reply);
    expect(typeof first).toBe('string');
    expect(JSON.parse(first)).toEqual({
      id: 'c1:1',
      result: { type: 'data', data: { answer: 42 } },
    });
    expect(second).toEqual({ id: 'c1:2', result: { type: 'data', data: { answer: 42 } } });
  });

  test.each([
    '{not json',
    '',
    'null',
    '[]',
    '"read"',
    text({ method: 'request' }),
    text(request('', 'query')),
    text({ method: 'subscription.stop', id: {} }),
  ])('drops undecodable or malformed text: %s', async (payload) => {
    const createContext = vi.fn();
    const target = attach({ router: query(), createContext });
    expect(() => send(target.event, payload)).not.toThrow();
    await flush();
    expect(createContext).not.toHaveBeenCalled();
    expect(target.reply).not.toHaveBeenCalled();
  });

  test('checks the sender before it decodes any text', async () => {
    const createContext = vi.fn();
    const attached = attach({ router: query(), createContext });
    const payload = text(request('c1:1'));
    const parse = vi.spyOn(JSON, 'parse');
    try {
      send(windowFixture(2).event, payload);
      send(fromSubframe(attached.event), payload);
      send({ ...attached.event, senderFrame: null }, payload);
      expect(parse).not.toHaveBeenCalledWith(payload);
    } finally {
      parse.mockRestore();
    }
    await flush();
    expect(createContext).not.toHaveBeenCalled();
  });

  test('still applies the application sender policy to text requests', async () => {
    const createContext = vi.fn();
    const target = attach({ router: query(), createContext, validateSender: () => false });
    send(target.event, text(request('c1:1')));
    await flush();
    expect(createContext).not.toHaveBeenCalled();
  });

  test('streams subscription events as text and stops on a text stop message', async () => {
    const stream = streamRouter();
    const target = attach({ router: stream.router });
    send(target.event, text(request('c1:1', 'subscription', 'stream')));
    await vi.waitFor(() => expect(stream.subscribed).toHaveBeenCalledOnce());
    stream.emit(7);
    const [, reply] = target.reply.mock.lastCall!;
    expect(JSON.parse(reply)).toEqual({ id: 'c1:1', result: { type: 'data', data: 7 } });
    send(target.event, text({ method: 'subscription.stop', id: 'c1:1' }));
    expect(stream.cleanup).toHaveBeenCalledOnce();
  });

  test('a text subscription event that JSON cannot represent ends the stream with a text error', async () => {
    const stream = streamRouter();
    const target = attach({ router: stream.router });
    send(target.event, text(request('c1:1', 'subscription', 'stream')));
    await vi.waitFor(() => expect(stream.subscribed).toHaveBeenCalledOnce());
    stream.emit(10n);
    expect(stream.cleanup).toHaveBeenCalledOnce();
    const [, reply] = target.reply.mock.lastCall!;
    expect(typeof reply).toBe('string');
    expect(JSON.parse(reply)).toMatchObject({
      id: 'c1:1',
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });
    target.reply.mockClear();
    stream.emit(1);
    expect(target.reply).not.toHaveBeenCalled();
  });

  test('a text subscription that completes sends a text stopped message', async () => {
    const stream = streamRouter();
    const target = attach({ router: stream.router });
    send(target.event, text(request('c1:1', 'subscription', 'stream')));
    await vi.waitFor(() => expect(stream.subscribed).toHaveBeenCalledOnce());
    stream.complete();
    const [, reply] = target.reply.mock.lastCall!;
    expect(typeof reply).toBe('string');
    expect(JSON.parse(reply)).toEqual({ id: 'c1:1', result: { type: 'stopped' } });
    expect(stream.cleanup).toHaveBeenCalledOnce();
  });

  test('reports a result that JSON cannot represent as a text error', async () => {
    const target = attach({ router: query() });
    send(target.event, text(request('c1:1', 'query', 'big')));
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    const [, reply] = target.reply.mock.calls[0];
    expect(typeof reply).toBe('string');
    expect(JSON.parse(reply)).toMatchObject({
      id: 'c1:1',
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    });
  });
});
