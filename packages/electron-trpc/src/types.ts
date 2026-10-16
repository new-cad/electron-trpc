import type { Operation } from '@trpc/client';
import type { TRPCResponseMessage } from '@trpc/server/rpc';

export type ETRPCRequest =
  | {
      method: 'request';
      // Neither the signal nor the context is sent: the router uses neither, and either can fail to
      // cross the bridge.
      operation: Pick<Operation, 'type' | 'path' | 'input'> & { id: number | string };
    }
  | { method: 'subscription.stop'; id: number | string };

/** How messages cross the context bridge: as objects (structured clone) or as JSON text. */
export type WireFormat = 'structured-clone' | 'json';

// Links using the `json` wire format exchange text; other links on the same bridge keep using objects.
export interface RendererGlobalElectronTRPC {
  sendMessage: (args: ETRPCRequest | string) => void;
  onMessage: (callback: (args: TRPCResponseMessage | string) => void) => void | (() => void);
}
