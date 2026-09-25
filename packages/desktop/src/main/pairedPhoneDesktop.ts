import { BrowserWindow, MessageChannelMain, ipcMain } from "electron";
import type { UtilityProcess, MessagePortMain } from "electron";
import { randomUUID } from "node:crypto";
import { connectViaProtocol } from "@zcode/client";
import { MessagePortProtocol } from "@zcode/rpc";
import { HostMessageTypes } from "@zcode/shared";
import { pairedPhonePort } from "./pairedPhonePort.js";
import { createPairedPhoneTransport, type PairedPhoneScope } from "./pairedPhoneTransport.js";

const CHANNEL = "zcode:paired-phone-consent";
function selection(value: unknown, windowId: number): PairedPhoneScope {
  if (!value || typeof value !== "object") throw new Error("phone selection denied");
  const input = value as Record<string, unknown>;
  for (const key of [
    "targetId",
    "workspaceId",
    "hostSessionId",
    "workspacePath",
    "workspaceIdentity",
  ]) {
    if (typeof input[key] !== "string" || !input[key] || input[key].length > 4096)
      throw new Error("phone selection denied");
  }
  if (input.workspaceIdentity !== (input.workspaceIdentity as string).trim())
    throw new Error("phone selection denied");
  return {
    windowId,
    targetId: input.targetId as string,
    workspaceId: input.workspaceId as string,
    hostSessionId: input.hostSessionId as string,
    workspacePath: input.workspacePath as string,
    workspaceIdentity: input.workspaceIdentity as string,
  };
}

/** Installed in actual Main composition; sender and utility Host are obtained, never renderer-provided. */
export function registerPairedPhoneDesktop(options: {
  hosts: Map<number, UtilityProcess>;
  rendererRoot: string;
}) {
  const portFor = (scope: PairedPhoneScope): MessagePortMain => {
    const win = BrowserWindow.getAllWindows().find((item) => item.id === scope.windowId);
    const child = win && options.hosts.get(win.webContents.id);
    if (!child || child.pid == null) throw new Error("phone Host unavailable");
    const { port1, port2 } = new MessageChannelMain();
    try {
      child.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId: randomUUID(),
          clientMode: "web-remote-replayable",
          scope: {
            kind: "phone",
            workspaceId: scope.workspaceId,
            hostSessionId: scope.hostSessionId,
            workspacePath: scope.workspacePath,
            workspaceIdentity: scope.workspaceIdentity,
          },
        },
        [port2],
      );
      return port1;
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
  };
  const transport = createPairedPhoneTransport({
    currentHost: (windowId) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.id === windowId);
      return win && options.hosts.get(win.webContents.id);
    },
    rendererRoot: options.rendererRoot,
    attachPort: portFor,
    async certify(scope) {
      const port = portFor(scope);
      const protocol = new MessagePortProtocol(pairedPhonePort(port));
      try {
        const services = connectViaProtocol(protocol);
        const host = services.agentHostService;
        const hierarchy = services.workspaceHierarchyService;
        if (!host || !hierarchy) throw new Error("phone owner denied");
        const targetId = scope.targetId;
        const spec = await host.getSessionSpec({
          targetId,
          workspaceId: scope.workspaceId,
          hostSessionId: scope.hostSessionId,
        });
        const owner = await hierarchy.resolveOwner({
          targetId,
          workspaceId: scope.workspaceId,
          sessionId: scope.hostSessionId,
        });
        if (
          !spec ||
          !owner ||
          owner.kind !== "external" ||
          owner.historyOnly ||
          owner.spec.hostSessionId !== spec.hostSessionId ||
          JSON.stringify(owner.spec) !== JSON.stringify(spec) ||
          owner.scope.workspaceIdentity !== scope.workspaceIdentity ||
          owner.scope.workspacePath !== scope.workspacePath ||
          owner.scope.workspaceId !== scope.workspaceId
        )
          throw new Error("phone owner denied");
        return owner;
      } finally {
        protocol.disconnect();
      }
    },
  });
  ipcMain.handle(CHANNEL, async (event, command: unknown, requested: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame)
      throw new Error("phone sender denied");
    if (command === "disable") {
      transport.revokeSelection(selection(requested, win.id));
      return null;
    }
    if (command !== "enable") throw new Error("phone command denied");
    return transport.enable(selection(requested, win.id));
  });
  return {
    revokeWindow: transport.revokeWindow,
    dispose() {
      ipcMain.removeHandler(CHANNEL);
      transport.dispose();
    },
  };
}
