import type { PiPeerFrame, PiRpcFrame } from "./piControlProtocol.js";
import type { PiTurnTransport } from "./piTurnTransport.js";

/** Translates one Pi transport. It does not own turn admission or the event log. */
export class PiRpcSession {
  readonly #transport: PiTurnTransport;
  readonly #onPeer: (frame: PiPeerFrame) => void;
  #ready?: (backendSessionId: string) => void;
  #missing?: (error: Error) => void;
  #closed = false;

  constructor(options: { transport: PiTurnTransport; onPeer: (frame: PiPeerFrame) => void }) {
    this.#transport = options.transport;
    this.#onPeer = options.onPeer;
    this.#transport.subscribe((frame) => this.#receive(frame));
  }

  async open(hostSessionId: string, runtimeEpoch: string): Promise<string> {
    const ready = new Promise<string>((resolve, reject) => {
      this.#ready = resolve;
      this.#missing = reject;
    });
    await this.#transport.send({ type: "session.open", hostSessionId, runtimeEpoch });
    return ready;
  }

  async send(frame: PiRpcFrame): Promise<void> {
    if (this.#closed) throw new Error("Pi transport is closed");
    await this.#transport.send(frame);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#missing?.(new Error("Pi transport closed"));
    await this.#transport.close();
  }

  #receive(frame: PiRpcFrame): void {
    if (!("type" in frame)) return;
    if (frame.type === "session.ready") {
      if (!frame.backendSessionId) {
        this.#missing?.(new Error("Pi session ready frame missing backend id"));
        return;
      }
      this.#ready?.(frame.backendSessionId);
      return;
    }
    if (isPeerFrame(frame)) this.#onPeer(frame);
  }
}

function isPeerFrame(frame: PiRpcFrame): frame is PiPeerFrame {
  return (
    frame.type !== "session.open" &&
    frame.type !== "turn.prompt" &&
    frame.type !== "turn.cancel" &&
    frame.type !== "approval.decision" &&
    frame.type !== "session.terminate"
  );
}
