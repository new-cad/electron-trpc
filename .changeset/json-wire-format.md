---
'@new-cad/electron-trpc': minor
---

Add an opt-in `wireFormat: 'json'` option to `ipcLink` that exchanges messages as JSON text instead of objects. Results made of many objects cross the context bridge several times faster; small calls are unchanged, and a single large string or buffer is slower, so the default stays `'structured-clone'`. The main process replies in the format each request used, and decodes text only after the attached-window and main-frame checks. Custom `electronTRPC` bridges must forward strings unchanged.

Build data replies directly instead of through tRPC's response helper, which lowers main-process CPU for high-frequency subscriptions.
