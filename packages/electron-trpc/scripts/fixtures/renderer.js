import { createTRPCClient } from '@trpc/client';
import { ipcLink } from '@new-cad/electron-trpc/renderer';
import superjson from 'superjson';

// The same router through both wire formats: `json` links exchange text instead of objects.
const bind = (wireFormat) => {
  const client = createTRPCClient({ links: [ipcLink({ transformer: superjson, wireFormat })] });
  let subscription;
  return {
    read: () => client.read.query(),
    date: (value) =>
      client.date.mutate(value).then((result) => result instanceof Date && result.toISOString()),
    start: () => {
      subscription = client.stream.subscribe(undefined, { onData() {} });
    },
    stop: () => {
      subscription?.unsubscribe();
    },
  };
};
window.transport = {
  ...bind('structured-clone'),
  json: bind('json'),
  // What each reply looked like when it reached the page: text for json links, objects otherwise.
  replyKinds: async (work) => {
    const kinds = [];
    const remove = window.electronTRPC.onMessage((reply) => kinds.push(typeof reply));
    await work();
    remove?.();
    return kinds;
  },
};

// Requests issued while the document loads are the earliest a new document can send.
if (location.search.includes('autostart')) {
  window.transport.start();
  window.autoRead = window.transport.read();
}
