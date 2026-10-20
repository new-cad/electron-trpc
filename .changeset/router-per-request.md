---
'@new-cad/electron-trpc': minor
---

Add a `resolveRouter` option to `createIPCHandler`, so one handler can serve a different router to each window. It receives each procedure call's `IpcMainEvent` after the sender checks and returns the router that serves it; `router` serves the calls for which it returns `undefined`. A `resolveRouter` that throws rejects the request, and stopping a subscription does not consult it.
