const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
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

// Without this, an exception thrown inside an IPC listener opens a modal error dialog and hangs.
process.on('uncaughtException', (error) => {
  console.error(error);
  app.exit(1);
});

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
      assert.equal(
        await run("window.transport.json.date(new Date('2026-01-01T00:00:00Z'))"),
        '2026-01-01T00:00:00.000Z',
        'A Date must survive the json wire format through superjson'
      );
      // Replies follow the format of their request, so a json link never receives objects.
      assert.deepEqual(
        await run('window.transport.replyKinds(() => window.transport.json.date(new Date()))'),
        ['string']
      );
      assert.deepEqual(
        await run('window.transport.replyKinds(() => window.transport.date(new Date()))'),
        ['object']
      );
      await run('window.transport.json.start()');
      await waitFor(() => streams === 1);
      await run('window.transport.json.stop(); window.transport.json.stop(); true');
      await waitFor(() => streams === 0);
      const raw =
        "window.electronTRPC.sendMessage({method:'request',operation:{id:'untrusted:1',type:'query',path:'read'}}); true";
      const rawText =
        "window.electronTRPC.sendMessage(JSON.stringify({method:'request',operation:{id:'untrusted:2',type:'query',path:'read'}})); true";
      const child = attached.webContents.mainFrame.frames[0];
      assert(child, 'Test iframe must exist');
      let arrived = 0;
      const countArrivals = () => arrived++;
      ipcMain.on(ELECTRON_TRPC_CHANNEL, countArrivals);
      await child.executeJavaScript(raw);
      await child.executeJavaScript(rawText);
      await other.webContents.executeJavaScript(raw);
      await run("window.electronTRPC.sendMessage('{not json'); true");
      allow = false;
      await run(raw);
      await run(rawText);
      await run('window.electronTRPC.sendMessage(null); true');
      // Wait until all seven rejected messages (subframe, unattached window, undecodable text, policy,
      // malformed) have reached the main process, so the assertion below cannot pass just because
      // they are in flight.
      await waitFor(() => arrived >= 7);
      ipcMain.removeListener(ELECTRON_TRPC_CHANNEL, countArrivals);
      await sleep(0); // let any wrongly accepted request run its promise chain before asserting
      assert.equal(calls, 1, 'Unauthorized and malformed requests must never execute');
      allow = true;
      await run('window.transport.start()');
      await waitFor(() => streams === 1);
      // A navigation that never replaces the document (blocked in will-navigate) must not revoke it.
      let blocked = false;
      attached.webContents.once('will-navigate', (event) => {
        event.preventDefault();
        blocked = true;
      });
      await run("location.assign('https://example.invalid/'); true");
      await waitFor(() => blocked);
      assert.equal(await run('window.transport.read()'), 'ok');
      assert.equal(calls, 2);
      assert.equal(streams, 1, 'A blocked navigation must not cancel the live subscription');
      await run('window.transport.stop(); window.transport.stop(); true');
      await waitFor(() => streams === 0);
      await run('window.transport.start()');
      await waitFor(() => streams === 1);
      const loaded = once(attached.webContents, 'did-finish-load');
      attached.webContents.reload();
      await loaded;
      await waitFor(() => streams === 0);
      // Work started by a replacement document while it loads must survive that document's commit.
      await attached.loadFile(path.join(output, 'index.html'), { query: { autostart: '1' } });
      assert.equal(await run('window.autoRead'), 'ok');
      await waitFor(() => streams === 1);
      await sleep(100); // a late revocation by the document's own did-navigate would land here
      assert.equal(streams, 1, 'A subscription started at load must survive the navigation commit');
      // A failed load that leaves the document in place must not revoke it.
      await attached.webContents.loadURL('http://[invalid').catch(() => {});
      assert.equal(await run('window.transport.read()'), 'ok');
      assert.equal(streams, 1, 'A rejected URL must not cancel the live subscription');
      // Chromium's error page replaces the document but emits did-fail-load instead of did-navigate.
      const closedPort = await new Promise((resolve) => {
        const server = net.createServer().listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          server.close(() => resolve(port));
        });
      });
      await attached.webContents.loadURL(`http://127.0.0.1:${closedPort}/`).catch(() => {});
      await waitFor(() => streams === 0);
      // Disposal must release a stream that is live at that moment.
      await attached.loadFile(path.join(output, 'index.html'));
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
