const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { initTRPC } = require('@trpc/server');
const { observable } = require('@trpc/server/observable');
const superjson = require('superjson').default;
const { createIPCHandler, ELECTRON_TRPC_CHANNEL } = require('../dist/main.cjs');

const output = process.argv.at(-1);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transport state');
    await sleep(10);
  }
}

app
  .whenReady()
  .then(async () => {
    let calls = 0;
    let streams = 0;
    let allow = true;
    const t = initTRPC.create({ transformer: superjson });
    const router = t.router({
      read: t.procedure.query(() => {
        calls++;
        return 'ok';
      }),
      date: t.procedure
        .input((value) => {
          assert(value instanceof Date);
          return value;
        })
        .mutation(({ input }) => input),
      stream: t.procedure.subscription(() =>
        observable((emit) => {
          streams++;
          emit.next('started');
          return () => {
            streams--;
          };
        })
      ),
    });
    const options = {
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        preload: path.join(output, 'preload.cjs'),
      },
    };
    const attached = new BrowserWindow(options);
    const other = new BrowserWindow(options);
    const handler = createIPCHandler({ router, windows: [attached], validateSender: () => allow });
    try {
      await Promise.all([
        attached.loadFile(path.join(output, 'index.html')),
        other.loadFile(path.join(output, 'index.html')),
      ]);
      const run = (code) => attached.webContents.executeJavaScript(code);
      assert.equal(await run('window.transport.read()'), 'ok');
      assert.equal(
        await run("window.transport.date(new Date('2026-01-01T00:00:00Z'))"),
        '2026-01-01T00:00:00.000Z'
      );
      const raw =
        "window.electronTRPC.sendMessage({method:'request',operation:{id:'untrusted:1',type:'query',path:'read',context:{}}}); true";
      const child = attached.webContents.mainFrame.frames[0];
      assert(child, 'Test iframe must exist');
      await child.executeJavaScript(raw);
      await other.webContents.executeJavaScript(raw);
      allow = false;
      await run(raw);
      await run('window.electronTRPC.sendMessage(null); true');
      await sleep(150);
      assert.equal(calls, 1, 'Unauthorized and malformed requests must never execute');
      allow = true;
      await run('window.transport.start()');
      await waitFor(() => streams === 1);
      await run('window.transport.stop(); window.transport.stop(); true');
      await waitFor(() => streams === 0);
      await run('window.transport.start()');
      await waitFor(() => streams === 1);
      const loaded = once(attached.webContents, 'did-finish-load');
      attached.webContents.reload();
      await loaded;
      await waitFor(() => streams === 0);
      await run('window.transport.start()');
      await waitFor(() => streams === 1);
      handler.dispose();
      await waitFor(() => streams === 0);
      assert.equal(ipcMain.listenerCount(ELECTRON_TRPC_CHANNEL), 0);
      console.log(
        'Electron transport tests passed: real IPC, transformed values, sender/frame rejection, cancellation, navigation, and disposal'
      );
    } finally {
      handler.dispose();
      attached.destroy();
      other.destroy();
    }
  })
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    }
  );
