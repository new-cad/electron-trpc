---
'@new-cad/electron-trpc': minor
---

Migrate the IPC transport to tRPC v11. This release requires matching tRPC client and server versions in the `^11.19.0` range.

Configure custom serialization on `ipcLink({ transformer })` instead of the tRPC client. The link supports separate input/output transformers and leaves operations from preceding links unchanged. Routers without a custom transformer can continue using `ipcLink()`.
