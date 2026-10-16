---
'@new-cad/electron-trpc': minor
---

Restrict IPC requests to attached windows' main frames, validate request envelopes, and support a synchronous trusted-document policy through `validateSender`. Empty window lists now deny all senders, so every `BrowserWindow` that calls the router must be listed or attached (content hosted in a `WebContentsView` or `<webview>` cannot be attached yet); rejected requests get no reply and are logged under the `electron-trpc:main:IPCHandler` debug namespace. Add explicit handler disposal and revoke subscriptions on main-frame document replacement (committed navigation or error page), destruction, crashes, and detachment. Renderer client ids now carry a per-document token.

Fix pending-subscription cancellation races, duplicate subscription cleanup, synchronous stream termination, context/transformer errors (undecodable input is reported as `PARSE_ERROR`), and falsy input handling. Release idle renderer clients and removable preload listeners, handle AbortSignal locally, and omit signals from serialized requests. Update the preload with the renderer to enable listener removal. `createContext` is typed with the `IpcMainEvent` it actually receives. `attachWindow` now throws for destroyed windows, and `detachWindow` ignores windows that are not attached and only needs `webContentsId` as an optional consistency check.

Require Electron 42 or newer, update development dependencies and CI, and keep tRPC/debug external to avoid duplicated runtime state. Applications remain responsible for trusted navigation, router authorization, and operation limits.
