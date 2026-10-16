import { EventEmitter } from 'node:events';
import { initTRPC } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ELECTRON_TRPC_CHANNEL } from '../../constants';
import { createIPCHandler } from '../createIPCHandler';

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
function windowFixture(id: number) {
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { processId: 7, routingId: 1, url: 'app://trusted/index.html' },
    isDestroyed: () => false,
  });
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const reply = vi.fn();
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame,
    reply,
  } as unknown as IpcMainEvent;
  return { win, contents, event, reply };
}
const request = (id = 'c1:1', type = 'query', path = 'read') => ({
  method: 'request',
  operation: { id, type, path, context: {} },
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Every way access to a document can end while work for it is still pending.
const revocations = ['navigation', 'error page', 'crash', 'detach', 'dispose'] as const;
function revoke(
  action: (typeof revocations)[number],
  target: ReturnType<typeof windowFixture>,
  handler: { detachWindow(win: BrowserWindow): void; dispose(): void }
) {
  if (action === 'navigation') target.contents.emit('did-navigate');
  if (action === 'error page') {
    // A failed load puts Chromium's error page in a new main frame and emits only `did-fail-load`.
    Object.assign(target.contents, {
      mainFrame: { processId: 8, routingId: 1, url: 'chrome-error://x/' },
    });
    target.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x/', true);
  }
  if (action === 'crash') target.contents.emit('render-process-gone');
  if (action === 'detach') handler.detachWindow(target.win);
  if (action === 'dispose') handler.dispose();
}

describe('IPC sender boundary', () => {
  test('only attached main frames may execute a procedure', async () => {
    const allowed = windowFixture(1);
    const other = windowFixture(2);
    const read = vi.fn(() => 'ok');
    const t = initTRPC.create();
    track(
      createIPCHandler({
        router: t.router({ read: t.procedure.query(read) }),
        windows: [allowed.win],
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, other.event, request());
    ipcMain.emit(
      ELECTRON_TRPC_CHANNEL,
      { ...allowed.event, senderFrame: { routingId: 10 } },
      request()
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, { ...allowed.event, senderFrame: null }, request());
    await flush();
    expect(read).not.toHaveBeenCalled();
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, allowed.event, request());
    await vi.waitFor(() => expect(allowed.reply).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledOnce();
  });

  test('an empty window list denies every sender', async () => {
    const target = windowFixture(1);
    const createContext = vi.fn();
    track(createIPCHandler({ router: initTRPC.create().router({}), createContext }));
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request());
    await flush();
    expect(createContext).not.toHaveBeenCalled();
  });

  test('serves senders accepted by the application policy', async () => {
    const target = windowFixture(1);
    const validateSender = vi.fn(() => true);
    const t = initTRPC.create();
    track(
      createIPCHandler({
        router: t.router({ read: t.procedure.query(() => 'ok') }),
        windows: [target.win],
        validateSender,
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request());
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    expect(validateSender).toHaveBeenCalledWith(target.event);
  });

  test.each([undefined, 1, 'yes', {}, Promise.resolve(true)])(
    'requires the application policy to return exactly true: %s',
    async (verdict) => {
      const target = windowFixture(1);
      const createContext = vi.fn();
      track(
        createIPCHandler({
          router: initTRPC.create().router({}),
          windows: [target.win],
          createContext,
          validateSender: (() => verdict) as unknown as () => boolean,
        })
      );
      ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request());
      await flush();
      expect(createContext).not.toHaveBeenCalled();
    }
  );

  test('checks application sender policy and fails closed if it throws', async () => {
    const target = windowFixture(1);
    const createContext = vi.fn();
    const validateSender = vi.fn(() => false);
    track(
      createIPCHandler({
        router: initTRPC.create().router({}),
        windows: [target.win],
        createContext,
        validateSender,
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request());
    validateSender.mockImplementation(() => {
      throw new Error('Policy failed');
    });
    expect(() => ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request())).not.toThrow();
    await flush();
    expect(validateSender).toHaveBeenCalledTimes(2);
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
    const target = windowFixture(1);
    const createContext = vi.fn();
    track(
      createIPCHandler({
        router: initTRPC.create().router({}),
        windows: [target.win],
        createContext,
      })
    );
    expect(() => ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, message)).not.toThrow();
    await flush();
    expect(createContext).not.toHaveBeenCalled();
    expect(target.reply).not.toHaveBeenCalled();
  });

  test('ignores a destroyed webContents without reading its native properties', () => {
    const target = windowFixture(1);
    const createContext = vi.fn();
    track(
      createIPCHandler({
        router: initTRPC.create().router({}),
        windows: [target.win],
        createContext,
      })
    );
    Object.defineProperty(target.contents, 'isDestroyed', { value: () => true });
    Object.defineProperty(target.contents, 'mainFrame', {
      get: () => {
        throw new Error('Object has been destroyed');
      },
    });
    expect(() => ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request())).not.toThrow();
    expect(createContext).not.toHaveBeenCalled();
  });

  test('accepts numeric request ids, including 0', async () => {
    const target = windowFixture(1);
    const t = initTRPC.create();
    track(
      createIPCHandler({
        router: t.router({ read: t.procedure.query(() => 'ok') }),
        windows: [target.win],
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, {
      method: 'request',
      operation: { id: 0, type: 'query', path: 'read', context: {} },
    });
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    expect(target.reply.mock.calls[0][1]).toMatchObject({ id: 0, result: { data: 'ok' } });
  });

  test('formats a context failure instead of rejecting the IPC listener', async () => {
    const target = windowFixture(1);
    track(
      createIPCHandler({
        router: initTRPC.create().router({}),
        windows: [target.win],
        createContext: async () => {
          throw new Error('Context failed');
        },
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request());
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
      createIPCHandler({ router: initTRPC.create().router({}), windows: [target.win, destroyed] })
    ).toThrow('destroyed');
    expect(target.contents.eventNames()).toEqual([]);
    expect(ipcMain.listenerCount(ELECTRON_TRPC_CHANNEL)).toBe(0);
  });

  test('cleans a destroyed WebContents without reading its destroyed native properties', () => {
    const target = windowFixture(1);
    track(createIPCHandler({ router: initTRPC.create().router({}), windows: [target.win] }));
    Object.defineProperty(target.contents, 'id', {
      get: () => {
        throw new Error('Object has been destroyed');
      },
    });
    expect(() => target.contents.emit('destroyed')).not.toThrow();
    expect(target.contents.eventNames()).toEqual([]);
  });

  test('a duplicate subscription ID cannot overwrite and leak the original stream', async () => {
    const target = windowFixture(1);
    const cleanup = vi.fn();
    const subscribe = vi.fn(() => observable(() => cleanup));
    const t = initTRPC.create();
    track(
      createIPCHandler({
        router: t.router({ stream: t.procedure.subscription(subscribe) }),
        windows: [target.win],
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request('c1:1', 'subscription', 'stream'));
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request('c1:1', 'subscription', 'stream'));
    await vi.waitFor(() => expect(target.reply).toHaveBeenCalledOnce());
    expect(cleanup).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(target.reply.mock.calls[0][1]).toMatchObject({ error: { data: { code: 'CONFLICT' } } });
  });

  test('cancels while an asynchronous subscription resolver is still pending', async () => {
    const target = windowFixture(1);
    let resolve!: (stream: ReturnType<typeof observable>) => void;
    const pending = new Promise<ReturnType<typeof observable>>((ready) => {
      resolve = ready;
    });
    const started = vi.fn();
    const t = initTRPC.create();
    track(
      createIPCHandler({
        router: t.router({
          stream: t.procedure.subscription(() => {
            started();
            return pending;
          }),
        }),
        windows: [target.win],
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request('c1:1', 'subscription', 'stream'));
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, { method: 'subscription.stop', id: 'c1:1' });
    const subscribe = vi.fn();
    resolve(observable(subscribe));
    await flush();
    expect(subscribe).not.toHaveBeenCalled();
    expect(target.reply).not.toHaveBeenCalled();
  });

  test('detaches all listeners and can be disposed repeatedly', () => {
    const target = windowFixture(1);
    const handler = track(
      createIPCHandler({ router: initTRPC.create().router({}), windows: [target.win] })
    );
    handler.attachWindow(target.win);
    expect(target.contents.listenerCount('did-navigate')).toBe(1);
    handler.detachWindow(target.win);
    expect(target.contents.eventNames()).toEqual([]);
    handler.attachWindow(target.win);
    handler.dispose();
    handler.dispose();
    expect(target.contents.eventNames()).toEqual([]);
    expect(ipcMain.listenerCount(ELECTRON_TRPC_CHANNEL)).toBe(0);
    expect(() => handler.attachWindow(target.win)).toThrow('disposed');
  });

  test.each(['stop', ...revocations] as const)(
    'cancels a subscription during asynchronous context creation: %s',
    async (action) => {
      const target = windowFixture(1);
      let ready!: (context: object) => void;
      const context = new Promise<object>((resolve) => {
        ready = resolve;
      });
      const subscribe = vi.fn(() => observable(() => {}));
      const t = initTRPC.create();
      const handler = track(
        createIPCHandler({
          router: t.router({ stream: t.procedure.subscription(subscribe) }),
          windows: [target.win],
          createContext: () => context,
        })
      );
      ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request('c1:1', 'subscription', 'stream'));
      if (action === 'stop') {
        ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, {
          method: 'subscription.stop',
          id: 'c1:1',
        });
      } else {
        revoke(action, target, handler);
      }
      ready({});
      await flush();
      expect(subscribe).not.toHaveBeenCalled();
      expect(target.reply).not.toHaveBeenCalled();
    }
  );

  function gatedQuery() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = vi.fn();
    const t = initTRPC.create();
    const router = t.router({
      read: t.procedure.query(async () => {
        started();
        await gate;
        return 'late';
      }),
    });
    return { router, release, started };
  }

  test.each(revocations)(
    'drops the reply of a query that is in flight when access is revoked: %s',
    async (action) => {
      const target = windowFixture(1);
      const { router, release, started } = gatedQuery();
      const handler = track(createIPCHandler({ router, windows: [target.win] }));
      ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request());
      await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
      revoke(action, target, handler);
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
      const target = windowFixture(1);
      let ready!: (context: object) => void;
      const context = new Promise<object>((resolve) => {
        ready = resolve;
      });
      const write = vi.fn(() => 'done');
      const t = initTRPC.create();
      const handler = track(
        createIPCHandler({
          router: t.router({ write: t.procedure.mutation(write) }),
          windows: [target.win],
          createContext: () => context,
        })
      );
      ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request('c1:1', 'mutation', 'write'));
      revoke(action, target, handler);
      ready({});
      await flush();
      expect(write).not.toHaveBeenCalled();
      expect(target.reply).not.toHaveBeenCalled();
    }
  );

  test('navigations that keep the document do not revoke work in flight', async () => {
    // Downloads, 204 responses and navigations cancelled in `will-navigate` all emit
    // `did-start-navigation` without replacing the document (the Electron smoke test covers the
    // last one). Subframe events and aborted loads do not replace the main-frame document either.
    const target = windowFixture(1);
    const { router, release, started } = gatedQuery();
    track(createIPCHandler({ router, windows: [target.win] }));
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request());
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
    const target = windowFixture(1);
    const { router, release, started } = gatedQuery();
    track(createIPCHandler({ router, windows: [target.win] }));
    const replacement = { processId: 7, routingId: 2, url: 'app://trusted/next.html' };
    Object.assign(target.contents, { mainFrame: replacement });
    target.contents.emit('did-navigate');
    const event = { ...target.event, senderFrame: replacement } as unknown as IpcMainEvent;
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, event, request());
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
    const target = windowFixture(1);
    const cleanup = vi.fn();
    const t = initTRPC.create();
    track(
      createIPCHandler({
        router: t.router({ stream: t.procedure.subscription(() => observable(() => cleanup)) }),
        windows: [target.win],
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, request('c1:1', 'subscription', 'stream'));
    await flush();
    Object.assign(target.contents, { mainFrame: { ...replacement, url: 'chrome-error://x/' } });
    target.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x/', true);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  test('copes with a main frame that cannot be read after the renderer is gone', async () => {
    const crashed = windowFixture(1);
    Object.defineProperty(crashed.contents, 'mainFrame', {
      get: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    });
    expect(() =>
      track(createIPCHandler({ router: initTRPC.create().router({}), windows: [crashed.win] }))
    ).not.toThrow();

    const live = windowFixture(2);
    const cleanup = vi.fn();
    const t = initTRPC.create();
    track(
      createIPCHandler({
        router: t.router({ stream: t.procedure.subscription(() => observable(() => cleanup)) }),
        windows: [live.win],
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, live.event, request('c1:1', 'subscription', 'stream'));
    await flush();
    Object.defineProperty(live.contents, 'mainFrame', {
      get: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    });
    expect(() => live.contents.emit('did-navigate')).not.toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(() =>
      live.contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://x/', true)
    ).not.toThrow();
  });

  test('ignores detachWindow for a window that is not attached', () => {
    const attached = windowFixture(1);
    const other = windowFixture(2);
    const handler = track(
      createIPCHandler({ router: initTRPC.create().router({}), windows: [attached.win] })
    );
    expect(() => handler.detachWindow(other.win)).not.toThrow();
    expect(attached.contents.listenerCount('did-navigate')).toBe(1);
  });

  test('stops serving a window once it is detached or destroyed', async () => {
    const detached = windowFixture(1);
    const destroyed = windowFixture(2);
    const cleanup = vi.fn();
    const createContext = vi.fn(() => ({}));
    const t = initTRPC.create();
    const handler = track(
      createIPCHandler({
        router: t.router({
          read: t.procedure.query(() => 'ok'),
          stream: t.procedure.subscription(() => observable(() => cleanup)),
        }),
        windows: [detached.win, destroyed.win],
        createContext,
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, destroyed.event, request('c1:1', 'subscription', 'stream'));
    await vi.waitFor(() => expect(createContext).toHaveBeenCalledOnce());
    await flush();
    destroyed.contents.emit('destroyed');
    expect(cleanup).toHaveBeenCalledOnce();

    handler.detachWindow(detached.win);
    createContext.mockClear();
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, detached.event, request());
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, destroyed.event, request());
    await flush();
    expect(createContext).not.toHaveBeenCalled();
  });

  test('refuses to detach a window under a different webContents id', () => {
    const target = windowFixture(1);
    const handler = track(
      createIPCHandler({ router: initTRPC.create().router({}), windows: [target.win] })
    );
    expect(() => handler.detachWindow(target.win, 2)).toThrow('does not match');
    expect(target.contents.listenerCount('did-navigate')).toBe(1);
    expect(target.contents.listenerCount('did-fail-load')).toBe(1);
  });

  test('navigation cleans only the matching window', async () => {
    const first = windowFixture(1);
    const second = windowFixture(10);
    const cleanup = vi.fn();
    const t = initTRPC.create();
    track(
      createIPCHandler({
        router: t.router({ stream: t.procedure.subscription(() => observable(() => cleanup)) }),
        windows: [first.win, second.win],
      })
    );
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, first.event, request('c1:1', 'subscription', 'stream'));
    ipcMain.emit(ELECTRON_TRPC_CHANNEL, second.event, request('c1:1', 'subscription', 'stream'));
    await flush();
    first.contents.emit('did-navigate');
    expect(cleanup).toHaveBeenCalledTimes(1);
    second.contents.emit('render-process-gone');
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
