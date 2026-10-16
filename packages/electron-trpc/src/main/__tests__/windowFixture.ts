import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainEvent } from 'electron';
import { vi } from 'vitest';

// A window whose main frame is process 7, routing id 1, and a message event sent by that frame.
export function windowFixture(id: number) {
  const contents = Object.assign(new EventEmitter(), {
    id,
    mainFrame: { processId: 7, routingId: 1, url: 'app://trusted/index.html' },
    isDestroyed: () => false,
  });
  const win = { webContents: contents, isDestroyed: () => false } as unknown as BrowserWindow;
  const reply = vi.fn();
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame,
    // The ids recorded when the message was sent; they name the frame that sent it.
    processId: contents.mainFrame.processId,
    frameId: contents.mainFrame.routingId,
    reply,
  } as unknown as IpcMainEvent;
  return { win, contents, event, reply };
}
