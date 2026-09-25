// 仅提取 V4 已定义的行/帧字段；ACK/control phase 不构成某一命令完成的证据。
interface Row {
  kind?: string;
  turnId?: string;
  sourceCommandId?: string;
  state?: string;
  text?: string;
  toolName?: string;
  status?: string;
  input?: unknown;
}
interface Frame {
  method?: string;
  params?: {
    frame?: {
      topic?: string;
      payload?: {
        kind?: string;
        snapshot?: { rows?: { window?: Row[] } };
        deltas?: Array<{ op?: string; row?: Row }>;
      };
    };
  };
}

export function nativeEvidenceRows(frame: Frame, sessionId: string): Row[] {
  if (
    frame.method !== "v4/conversation/frame" ||
    frame.params?.frame?.topic !== `conversation/${sessionId}`
  )
    return [];
  const payload = frame.params.frame.payload;
  return payload?.kind === "snapshot"
    ? (payload.snapshot?.rows?.window ?? [])
    : (payload?.deltas?.flatMap((delta) =>
        (delta.op === "row.appended" || delta.op === "row.upserted") && delta.row
          ? [delta.row]
          : [],
      ) ?? []);
}

export function matchingTerminal(rows: readonly Row[], commandId: string): string | undefined {
  return rows.find(
    (row) =>
      row.kind === "turnHeader" &&
      row.sourceCommandId === commandId &&
      row.state === "completedSuccess",
  )?.turnId;
}

export function matchingFinalAnswer(
  rows: readonly Row[],
  turnId: string,
  expected: string,
): boolean {
  return rows.some(
    (row) =>
      row.kind === "assistantText" &&
      row.turnId === turnId &&
      row.state === "complete" &&
      row.text?.includes(expected),
  );
}

interface FixturePermissionInput {
  toolName: string;
  params: unknown;
  cwd: string;
  readPath: string;
  writePath: string;
  writeContent: string;
  bashCommand: string;
  phase: number;
  deniedWrites: number;
}

export function isExactFixtureAction(input: FixturePermissionInput): boolean {
  const data = typeof input.params === "string" ? safeObject(input.params) : input.params;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const args = data as Record<string, unknown>;
  const keys = Object.keys(args).sort().join(",");
  // 输入闭集：不能把 cwd、额外 shell effect 或其他工具参数顺手带入批准范围。
  return (
    (input.toolName === "Read" &&
      input.phase >= 1 &&
      keys === "file_path" &&
      args.file_path === input.readPath) ||
    (input.toolName === "Write" &&
      input.phase === 1 &&
      keys === "content,file_path" &&
      args.file_path === input.writePath &&
      args.content === input.writeContent) ||
    (input.toolName === "Bash" &&
      input.phase === 1 &&
      keys === "command" &&
      args.command === input.bashCommand)
  );
}

export function permittedFixtureAction(input: FixturePermissionInput): "allow" | "deny" {
  // 修复：首次 Write 拒绝也必须先验证其完整输入；坏输入拒绝但不计作成功测试步骤。
  if (!isExactFixtureAction(input)) return "deny";
  return input.toolName === "Write" && input.deniedWrites === 0 ? "deny" : "allow";
}
function safeObject(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
