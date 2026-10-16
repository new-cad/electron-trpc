import type { Operation } from '@trpc/client';
import type { TRPCResponseMessage } from '@trpc/server/rpc';

export type ETRPCRequest =
  | { method: 'request'; operation: Omit<Operation, 'id' | 'signal'> & { id: number | string } }
  | { method: 'subscription.stop'; id: number | string };

export interface RendererGlobalElectronTRPC {
  sendMessage: (args: ETRPCRequest) => void;
  onMessage: (callback: (args: TRPCResponseMessage) => void) => void | (() => void);
}
