# @new-cad/electron-trpc

<p></p>

**Build IPC for Electron with tRPC**

- Expose APIs from Electron's main process to one or more render processes.
- Build fully type-safe IPC.
- Communicate over Electron IPC without opening a localhost server.
- Full support for queries, mutations, and subscriptions.

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

     const handler = createIPCHandler({ router, windows: [win] });
     app.once('before-quit', () => handler.dispose());
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
For routers without a transformer, continue using `ipcLink()`.

## Sender authorization and lifecycle

Only the main frames of explicitly attached windows can invoke the router. An empty `windows` list authorizes no windows. Subframes and unattached windows are rejected before deserialization or context creation. Malformed request envelopes are ignored.

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

The policy must return `true` synchronously; thrown errors reject the request. For packaged files or a development server, supply your own exact file URL or origin policy. Avoid substring checks. A rejected request receives no response. Router middleware remains responsible for user authorization, input validation, and application-specific limits. See Electron's [security checklist](https://www.electronjs.org/docs/latest/tutorial/security).

Use one handler per router/transport channel. `handler.attachWindow(win)` adds a trusted window, `handler.detachWindow(win)` revokes it, and `handler.dispose()` removes the handler's IPC and window listeners. Destroying a window detaches it automatically. Main-frame document navigation and renderer crashes cancel its subscriptions; pending work cannot create a subscription or reply into the replacement document. In-page and subframe navigation leave main-frame subscriptions running.

Client unsubscription and `AbortSignal` cancellation release renderer listeners and stop subscriptions, including those waiting for context or resolver completion. Cancellation does not roll back a query or mutation already executing in the main process. Update the preload alongside the renderer to enable listener removal; older custom bridges returning no disposer remain compatible but retain their single message listener.

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

`test:electron` exercises the built transport in isolated, sandboxed Electron windows, including sender rejection and subscription cleanup. On headless Linux, run `xvfb-run --auto-servernum corepack pnpm test:electron`. CI runs the build, unit tests, and Electron checks on Windows and Linux.
