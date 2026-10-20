# @new-cad/electron-trpc

<p></p>

**Build IPC for Electron with tRPC**

- Expose APIs from Electron's main process to one or more render processes.
- Build fully type-safe IPC.
- Communicate over Electron IPC without opening a localhost server.
- Support for queries, mutations, and `observable()` subscriptions.

Requires Electron 42 or newer and matching `@trpc/client` and `@trpc/server` versions 11.19.0 or later in the v11 series. Keep Electron on a supported release with current security patches.

## Installation

```sh
# Using pnpm
pnpm add @new-cad/electron-trpc

# Using yarn
yarn add @new-cad/electron-trpc

# Using npm
npm install --save @new-cad/electron-trpc
```

## Basic Setup

1. Add your tRPC router to the Electron main process using `createIPCHandler`:

   ```ts
   import { app, BrowserWindow } from 'electron';
   import { createIPCHandler } from '@new-cad/electron-trpc/main';
   import { router } from './api';

   app.on('ready', () => {
     const win = new BrowserWindow({
       webPreferences: {
         // Replace this path with the path to your preload file (see next step)
         preload: 'path/to/preload.js',
         contextIsolation: true,
         sandbox: true,
         nodeIntegration: false,
       },
     });

     createIPCHandler({ router, windows: [win] });
   });
   ```

2. Expose the IPC to the render process from the [preload file](https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts):

   ```ts
   import { exposeElectronTRPC } from '@new-cad/electron-trpc/main';

   process.once('loaded', async () => {
     exposeElectronTRPC();
   });
   ```

   > Note: `@new-cad/electron-trpc` depends on `contextIsolation` being enabled, which is the default.

3. When creating the client in the render process, use the `ipcLink` (instead of the HTTP or batch HTTP links):

   ```ts
   import { createTRPCProxyClient } from '@trpc/client';
   import { ipcLink } from '@new-cad/electron-trpc/renderer';

   export const client = createTRPCProxyClient({
     links: [ipcLink()],
   });
   ```

4. Now you can use the client in your render process as you normally would (e.g. using `@trpc/react`).

   Subscriptions must return an `observable()`. tRPC v11 async-generator subscriptions are not supported over IPC, and `onStarted` and the resolver `signal` are not provided.

## Data transformers

With tRPC v11, configure the transformer on the IPC link rather than on the client:

```ts
import { createTRPCClient } from '@trpc/client';
import { ipcLink } from '@new-cad/electron-trpc/renderer';
import superjson from 'superjson';
import type { AppRouter } from './api';

export const client = createTRPCClient<AppRouter>({
  links: [ipcLink({ transformer: superjson })],
});
```

Configure the same transformer on `initTRPC.create({ transformer: superjson })` in the main process.
Separate input and output transformers are also supported through `{ transformer: { input, output } }`.
For routers without a transformer, continue using `ipcLink()`. The link is not checked against the router's transformer at compile time; a mismatch shows up at runtime as inputs that silently arrive empty or undecoded, or as untransformed results.

## Large results

By default, messages cross Electron's context bridge as objects, which are copied and structured-cloned at every hop. For results made of many small objects, that copying is most of the cost of a call. Set `wireFormat: 'json'` to send the same messages as JSON text, which crosses the bridge as a plain string:

```ts
ipcLink({ transformer: superjson, wireFormat: 'json' });
```

The main process answers each message in the format it arrived in, so it needs no configuration, and links with different formats can share a window. Measured on Electron 44 in a sandboxed macOS window, a call returning 10 objects was about 25% faster, 200 objects about 3x faster, and 2000 or more objects 4 to 5x faster. Calls with small payloads cost the same.

JSON text keeps only JSON values, unless your transformer encodes the rest (superjson handles `Date`, `Map`, and `BigInt`). Without one, `undefined` properties are dropped, `NaN` becomes `null`, a `Date` becomes a string, a `Map` becomes `{}`, and a `BigInt` or circular structure fails the call. Large strings and binary data are slower as JSON, so keep the default for those. The main process decodes text only after confirming that it comes from an attached window's main frame, and before it consults `validateSender`. Custom `electronTRPC` bridges must pass strings through unchanged.

## Sender authorization and lifecycle

Only the main frames of explicitly attached windows can invoke the router. An empty `windows` list authorizes no windows. Subframes and unattached windows are rejected before deserialization or context creation. Malformed request envelopes are ignored. Attachment takes a `BrowserWindow`: content hosted in a `WebContentsView` (for example inside a `BaseWindow`) or a `<webview>` has its own `webContents`, which cannot be attached yet and therefore cannot call the router.

An attached window remains attached across navigation. Restrict navigation and new-window creation in your application, and use `validateSender` to allow only your application's trusted documents. For example, an application served from a registered `app:` protocol can require its exact host:

```ts
const handler = createIPCHandler({
  router,
  windows: [win],
  validateSender: ({ senderFrame }) => {
    const url = new URL(senderFrame!.url);
    return url.protocol === 'app:' && url.host === 'newcad';
  },
});
```

The policy must return `true` synchronously; thrown errors reject the request. For packaged files or a development server, supply your own exact file URL or origin policy. Avoid substring checks. A rejected request receives no response, so a window that was never attached shows up as calls that never settle; every rejection is logged under the `electron-trpc:main:IPCHandler` [debug](https://www.npmjs.com/package/debug) namespace (`DEBUG=electron-trpc:*`). Router middleware remains responsible for user authorization, input validation, and application-specific limits. See Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security). tRPC includes stack traces with local file paths in error responses whenever `isDev` is true, and `isDev` defaults to `NODE_ENV !== 'production'`. Packaged apps usually leave `NODE_ENV` unset, so consider `initTRPC.create({ isDev: !app.isPackaged })`.

Use a single handler: the IPC channel is fixed, and attaching a window to two handlers runs each of its requests twice. To serve several routers, give that handler a `resolveRouter` (see [Several routers](#several-routers)). `handler.attachWindow(win)` adds a trusted window, `handler.detachWindow(win)` revokes it, and `handler.dispose()` removes the handler's IPC and window listeners. Destroying a window detaches it automatically, and process exit needs no cleanup; use `dispose()` to retire a handler early (for example on hot reload). Do not call it from `before-quit`, which can be cancelled. Replacing the main-frame document (a committed navigation or Chromium's error page) and renderer crashes cancel its subscriptions; pending work cannot create a subscription or reply into the replacement document. Work that is revoked this way, or by `detachWindow` and `dispose`, gets no reply. Navigations that leave the document in place (in-page navigation, downloads, navigations cancelled in `will-navigate`, loads that fail without replacing the page, such as an invalid URL) and subframe navigation leave main-frame subscriptions running.

Client unsubscription and `AbortSignal` cancellation release renderer listeners and stop subscriptions, including those waiting for context or resolver completion. Cancellation does not roll back a query or mutation already executing in the main process. Update the preload alongside the renderer to enable listener removal; older custom bridges returning no disposer remain compatible but retain their single message listener.

## Several routers

One handler can serve a different router to each window, for example when each window works on its own database. `resolveRouter` receives each request's `IpcMainEvent` after the sender checks and returns the router that serves it; `router` serves the requests for which it returns `undefined`.

```ts
const routers = new Map<WebContents, AppRouter>();

const handler = createIPCHandler({
  router: defaultRouter,
  resolveRouter: (event) => routers.get(event.sender),
});

function openWindow(router: AppRouter) {
  const win = new BrowserWindow({ webPreferences: { preload: 'path/to/preload.js' } });
  routers.set(win.webContents, router);
  win.once('closed', () => routers.delete(win.webContents));
  handler.attachWindow(win);
  return win;
}
```

The routers share one type, so one client type fits every window, and `createContext` serves them all. A `resolveRouter` that throws rejects the request, as `validateSender` does. Stopping a subscription does not consult it.

## Development

Use Node.js 24 and the pinned pnpm version through Corepack:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm test:ci
corepack pnpm test:electron
corepack pnpm lint
corepack pnpm audit
```

`test:electron` exercises the built transport in isolated Electron windows (sandboxed, except on Linux CI where Chromium's sandbox is disabled), including sender rejection and subscription cleanup. On headless Linux, run `xvfb-run --auto-servernum corepack pnpm test:electron`. CI runs the build, unit tests, and Electron checks on Windows and Linux.
