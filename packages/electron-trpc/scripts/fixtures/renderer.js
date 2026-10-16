import { createTRPCClient } from '@trpc/client';
import { ipcLink } from '@new-cad/electron-trpc/renderer';
import superjson from 'superjson';

const client = createTRPCClient({ links: [ipcLink({ transformer: superjson })] });
let subscription;
window.transport = {
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
