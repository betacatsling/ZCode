import type { MessagePortMain } from "electron";
import type { MessagePortLike, MessagePortPayload } from "@zcode/rpc";

/** Main adapter for the existing Host's binary MessagePort; no RPC privilege is added. */
export function pairedPhonePort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (event: { data: MessagePortPayload }) => void) {
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (event: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}
