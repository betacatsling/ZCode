import type { PiRpcFrame } from "./piControlProtocol.js";

export type { PiHostFrame, PiPeerFrame, PiRpcFrame } from "./piControlProtocol.js";

/** Port to a Pi process. Listeners must return without waiting for a later host frame. */
export interface PiTurnTransport {
  send(frame: PiRpcFrame): Promise<void>;
  subscribe(listener: (frame: PiRpcFrame) => void): () => void;
  close(): Promise<void>;
}

/** In-process pair for tests and local fakes. It does not start Pi. */
export function createLinkedPiTurnTransport(): { host: PiTurnTransport; peer: PiTurnTransport } {
  let closed = false;
  const hostListeners = new Set<(frame: PiRpcFrame) => void>();
  const peerListeners = new Set<(frame: PiRpcFrame) => void>();

  function deliver(target: Set<(frame: PiRpcFrame) => void>, frame: PiRpcFrame): void {
    if (closed) throw new Error("Pi transport is closed");
    for (const listener of Array.from(target)) listener(frame);
  }

  function side(
    mine: Set<(frame: PiRpcFrame) => void>,
    opposite: Set<(frame: PiRpcFrame) => void>,
  ): PiTurnTransport {
    return {
      async send(frame) {
        deliver(opposite, frame);
      },
      subscribe(listener) {
        mine.add(listener);
        return () => mine.delete(listener);
      },
      async close() {
        closed = true;
        hostListeners.clear();
        peerListeners.clear();
      },
    };
  }

  return {
    host: side(hostListeners, peerListeners),
    peer: side(peerListeners, hostListeners),
  };
}
