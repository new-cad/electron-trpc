---
'@new-cad/electron-trpc': minor
---

Restrict IPC requests to attached windows' main frames, validate request envelopes, and support a synchronous trusted-document policy through `validateSender`. Empty window lists now deny all senders. Add explicit handler disposal and revoke subscriptions on navigation, destruction, crashes, and detachment.

Fix pending-subscription cancellation races, duplicate subscription cleanup, synchronous stream termination, context/transformer errors, and falsy input handling. Release idle renderer clients and removable preload listeners, handle AbortSignal locally, and omit signals from serialized requests. Update the preload with the renderer to enable listener removal.

Require Electron 42 or newer, update development dependencies and CI, and keep tRPC/debug external to avoid duplicated runtime state. Applications remain responsible for trusted navigation, router authorization, and operation limits.
