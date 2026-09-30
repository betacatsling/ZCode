import { z } from "zod";

export const SERVER_REMOTE_PROTOCOL_VERSION = 1;

export const serverRemoteWorkspaceInfoSchema = z.object({
  path: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  workspaceIdentity: z.string().trim().min(1).optional(),
});

// `/api/server-info` is unauthenticated (docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md, "Local
// endpoints"), so servers publish only what real clients read: Server Core keeps `serverId` (the
// Desktop Host checks the target identity before it sends the bootstrap secret) and omits
// `workspaces`; the legacy server omits `serverId`/`name` and keeps `workspaces[].path` /
// `workspaceIdentity` for its Web UI. Both fields stay in the schema, optional, for old servers.
export const serverRemoteInfoSchema = z.object({
  serverId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  version: z.string(),
  protocolVersion: z.literal(SERVER_REMOTE_PROTOCOL_VERSION),
  authRequired: z.boolean(),
  workspaces: z.array(serverRemoteWorkspaceInfoSchema).optional(),
  capabilities: z.object({
    desktopContinuous: z.literal(true),
    websocketRpc: z.literal(true),
    // 旧 Server 缺少新增 dynamic event，必须先声明能力再订阅，避免异常打进对端读循环。
    processResourceTelemetry: z.boolean().optional(),
    /** Optional for pre-migration remote hosts. The trusted /ws/host channel is required. */
    agentHost: z.boolean().optional(),
  }),
});

export type ServerRemoteWorkspaceInfo = z.infer<typeof serverRemoteWorkspaceInfoSchema>;

export type ServerRemoteInfo = z.infer<typeof serverRemoteInfoSchema>;

export const serverRemoteHostCapabilitySchema = z
  .object({
    capability: z.string().trim().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type ServerRemoteHostCapability = z.infer<typeof serverRemoteHostCapabilitySchema>;
