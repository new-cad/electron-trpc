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
    mainFrame: { routingId: 1, url: 'app://trusted/index.html' },
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
    { method: 'request', operation: { id: {}, type: 'query', path: 'read' } },
    { method: 'request', operation: { id: 1, type: 'query', path: 123 } },
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
    expect(target.contents.listenerCount('did-start-navigation')).toBe(1);
    handler.detachWindow(target.win);
    expect(target.contents.eventNames()).toEqual([]);
    handler.attachWindow(target.win);
    handler.dispose();
    handler.dispose();
    expect(target.contents.eventNames()).toEqual([]);
    expect(ipcMain.listenerCount(ELECTRON_TRPC_CHANNEL)).toBe(0);
    expect(() => handler.attachWindow(target.win)).toThrow('disposed');
  });

  test.each(['stop', 'navigation', 'detach', 'dispose'] as const)(
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
      if (action === 'stop')
        ipcMain.emit(ELECTRON_TRPC_CHANNEL, target.event, {
          method: 'subscription.stop',
          id: 'c1:1',
        });
      if (action === 'navigation')
        target.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
      if (action === 'detach') handler.detachWindow(target.win);
      if (action === 'dispose') handler.dispose();
      ready({});
      await flush();
      expect(subscribe).not.toHaveBeenCalled();
      expect(target.reply).not.toHaveBeenCalled();
    }
  );

  test('navigation cleans only the matching window and ignores iframe/hash navigation', async () => {
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
    first.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    first.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(cleanup).not.toHaveBeenCalled();
    first.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(cleanup).toHaveBeenCalledTimes(1);
    second.contents.emit('render-process-gone');
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
