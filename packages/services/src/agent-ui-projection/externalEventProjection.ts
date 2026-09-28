import type { AgentEvent } from "@zcode/shared/agent-host";
import type {
  ConversationRow,
  PlanState,
  SubagentProjectionState,
  ToolCallRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";

type RowBase = Pick<ConversationRow, "rowId" | "turnId" | "createdAt" | "createdAtSeq">;
type FileChanged = Extract<AgentEvent, { kind: "file.changed" }>;
type ToolStarted = Extract<AgentEvent, { kind: "tool.started" }>;
type ToolFinished = Extract<AgentEvent, { kind: "tool.finished" }>;

interface FileDiffDisplay {
  kind: "file_diff";
  filePath: string;
  additions: number;
  deletions: number;
  structuredPatch: [];
}

/** 宿主事件里 V4 没有一等字段的细节。投影必须留下这些事实，不能在快照里丢掉。 */
export function createExternalEventProjection(): {
  plan: PlanState | null;
  subagents: () => SubagentProjectionState;
  hasFileSeed: (toolCallId: string) => boolean;
  adoptFileSeed: (event: ToolStarted, tools: Map<string, ToolCallRow>) => void;
  onFileChanged: (
    event: FileChanged,
    input: {
      headers: Map<string, TurnHeaderRow>;
      tools: Map<string, ToolCallRow>;
      rows: ConversationRow[];
      base: (event: AgentEvent) => RowBase;
    },
  ) => void;
  onToolFinished: (event: ToolFinished, row: ToolCallRow) => void;
  onPlan: (event: Extract<AgentEvent, { kind: "plan.updated" }>) => void;
  onSubagent: (
    event: Extract<AgentEvent, { kind: "subagent.updated" }>,
    rows: ConversationRow[],
    base: (event: AgentEvent) => RowBase,
  ) => void;
  onExtension: (
    event: Extract<AgentEvent, { kind: "extension.event" }>,
    rows: ConversationRow[],
    base: (event: AgentEvent) => RowBase,
  ) => void;
} {
  const fileLines = new Map<string, string[]>();
  const fileDisplays = new Map<string, FileDiffDisplay>();
  const toolTexts = new Map<string, string>();
  const seededByFile = new Set<string>();
  const subagentRows = new Map<string, Extract<ConversationRow, { kind: "subagent" }>>();
  let plan: PlanState | null = null;
  let subagentRevision = 0;
  let endedTotal = 0;

  const writeFileOutput = (row: ToolCallRow, toolCallId: string): void => {
    const lines = fileLines.get(toolCallId) ?? [];
    const toolText = toolTexts.get(toolCallId);
    const display = fileDisplays.get(toolCallId);
    const text = [...lines, ...(toolText ? [toolText] : [])].join("\n");
    if (!text && !display) return;
    row.output = display ? { text, display } : { text };
  };

  return {
    get plan() {
      return plan;
    },
    subagents() {
      const running = [...subagentRows.values()].flatMap((row) => {
        if (row.status !== "running" || !row.childSessionId) return [];
        return [
          {
            childSessionId: row.childSessionId,
            subagentType: "unknown",
            title: row.childSessionId,
            status: "running" as const,
            ...(row.startedAt !== undefined ? { startedAt: row.startedAt } : {}),
          },
        ];
      });
      return {
        revision: subagentRevision,
        childSessionIds: [...subagentRows.keys()],
        running,
        endedTotal,
      };
    },
    hasFileSeed(toolCallId) {
      return seededByFile.has(toolCallId);
    },
    adoptFileSeed(event, tools) {
      // file.changed 可能先于 tool.started 到达。已有行只补参数，不把路径覆盖掉。
      const row = tools.get(event.toolCallId);
      if (!row) return;
      seededByFile.delete(event.toolCallId);
      if (event.inputText !== undefined) row.inputText = event.inputText;
    },
    onFileChanged(event, input) {
      const header = input.headers.get(event.turnId);
      if (!header) throw new Error("file change outside turn");
      const previous = header.fileChanges;
      header.fileChanges = {
        files: (previous?.files ?? 0) + 1,
        additions: (previous?.additions ?? 0) + event.additions,
        deletions: (previous?.deletions ?? 0) + event.deletions,
      };
      let row = input.tools.get(event.toolCallId);
      if (row && row.turnId !== event.turnId) throw new Error("file change outside turn");
      if (!row) {
        row = {
          ...input.base(event),
          kind: "toolCall",
          toolCallId: event.toolCallId,
          toolName: event.name,
          inputText: "",
          status: "running",
          startedAt: event.at,
        };
        input.rows.push(row);
        input.tools.set(event.toolCallId, row);
        seededByFile.add(event.toolCallId);
      }
      const lines = fileLines.get(event.toolCallId) ?? [];
      lines.push(`${event.path}\t+${event.additions}\t-${event.deletions}`);
      fileLines.set(event.toolCallId, lines);
      fileDisplays.set(event.toolCallId, {
        kind: "file_diff",
        filePath: event.path,
        additions: event.additions,
        deletions: event.deletions,
        structuredPatch: [],
      });
      writeFileOutput(row, event.toolCallId);
    },
    onToolFinished(event, row) {
      // 只有完整 JSON 才写入 input。半截参数留在 inputText，不能变成最终工具调用。
      if (row.inputText.trim()) {
        try {
          row.input = JSON.parse(row.inputText) as unknown;
        } catch {
          // 解析失败说明参数还不是合法 JSON。
        }
      }
      if (event.outputText !== undefined) toolTexts.set(event.toolCallId, event.outputText);
      if (event.outputText === undefined && !fileLines.has(event.toolCallId)) return;
      writeFileOutput(row, event.toolCallId);
    },
    onPlan(event) {
      // 宿主计划事件只有整段 text，没有分步状态。保留全文，不拆成伪造的进度。
      plan = {
        items: [{ id: event.eventId, content: event.text, status: "pending" }],
        updatedAt: event.at,
      };
    },
    onSubagent(event, rows, base) {
      subagentRevision += 1;
      const existing = subagentRows.get(event.childSessionId);
      if (event.status === "started") {
        if (existing) throw new Error("duplicate subagent");
        const row: Extract<ConversationRow, { kind: "subagent" }> = {
          ...base(event),
          kind: "subagent",
          subagentType: "unknown",
          status: "running",
          summaryText: "",
          childSessionId: event.childSessionId,
          startedAt: event.at,
        };
        rows.push(row);
        subagentRows.set(event.childSessionId, row);
        return;
      }
      if (!existing || existing.status !== "running") throw new Error("subagent without start");
      existing.status = event.status === "finished" ? "success" : "failed";
      existing.endedAt = event.at;
      endedTotal += 1;
    },
    onExtension(event, rows, base) {
      // 扩展 payload 只展示，不写入 input，避免被当成可执行工具参数。
      const text = inertPayload(event.payload);
      rows.push({
        ...base(event),
        kind: "toolCall",
        toolCallId: event.eventId,
        toolName: event.namespace,
        inputText: "",
        status: "error",
        startedAt: event.at,
        endedAt: event.at,
        error: {
          code: "extension-ui-unsupported",
          message: `${event.namespace}@${event.version} is not executable`,
        },
        output: { text: `v${event.version}\n${text}` },
      });
    },
  };
}

function inertPayload(payload: unknown): string {
  try {
    const text = JSON.stringify(payload);
    return text === undefined ? "[unrenderable]" : text.slice(0, 1024);
  } catch {
    return "[unrenderable]";
  }
}
