import {
  TopicWireFrameAssembler,
  applyConversationDeltas,
  conversationTopicFrameSchema,
  conversationTopicWireCandidateSchema,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type PendingInteraction,
  type ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";

type JsonRecord = Record<string, unknown>;

export interface CurrentPendingPermission {
  readonly interaction: PermissionPendingInteraction;
  readonly toolRow: ToolCallRow;
}

export type PermissionPendingInteraction = Omit<PendingInteraction, "kind" | "payload"> & {
  readonly kind: "permission";
  readonly payload: Extract<PendingInteraction["payload"], { kind: "permission" }>;
};

const MAX_PRE_ACK_WIRES = 64;

function objectRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export class NativeV4ConversationState {
  private readonly assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  private readonly bufferedWires: ConversationTopicWireCandidate[] = [];
  private readonly changeListeners = new Set<() => void>();
  private subscriptionId: string | undefined;
  private logEpoch: string | undefined;
  private currentSnapshot: ConversationSnapshot | undefined;
  private failure: Error | undefined;
  private version = 0;

  constructor(readonly sessionId: string) {}

  get snapshot(): ConversationSnapshot | undefined {
    return this.currentSnapshot;
  }

  get changeVersion(): number {
    return this.version;
  }

  configureSubscription(subscriptionId: string, logEpoch: string): void {
    if (!subscriptionId || !logEpoch) throw new Error("native V4 subscription identity is empty");
    if (this.subscriptionId)
      throw new Error("native V4 subscription identity was configured twice");
    this.subscriptionId = subscriptionId;
    this.logEpoch = logEpoch;
    for (const wire of this.bufferedWires) {
      if (wire.subscriptionId === subscriptionId) {
        try {
          this.acceptOwnedWire(wire);
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    this.bufferedWires.length = 0;
    this.raiseFailure();
  }

  acceptNotification(params: unknown): void {
    this.raiseFailure();
    const envelope = objectRecord(params);
    if (envelope?.topic !== `conversation/${this.sessionId}`) return;
    const parsed = conversationTopicWireCandidateSchema.safeParse(params);
    if (!parsed.success) {
      this.fail(new Error(`invalid native V4 conversation wire: ${parsed.error.message}`));
      return;
    }
    if (!this.subscriptionId) {
      if (this.bufferedWires.length >= MAX_PRE_ACK_WIRES) {
        this.fail(new Error("native V4 pre-ack wire buffer exceeded its bound"));
        return;
      }
      this.bufferedWires.push(parsed.data);
      return;
    }
    if (parsed.data.subscriptionId !== this.subscriptionId) return;
    try {
      this.acceptOwnedWire(parsed.data);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  pendingPermissionsForTurn(turnId: string): CurrentPendingPermission[] {
    const snapshot = this.currentSnapshot;
    if (!snapshot || this.latestTurnId(snapshot) !== turnId) return [];
    const currentHeader = snapshot.rows.window.findLast(
      (row) => row.kind === "turnHeader" && row.turnId === turnId,
    );
    if (currentHeader?.kind !== "turnHeader" || currentHeader.state !== "running") return [];
    const rows = snapshot.rows.window.filter(
      (row): row is ToolCallRow =>
        row.kind === "toolCall" &&
        row.turnId === turnId &&
        row.status === "pendingApproval" &&
        typeof row.approvalInteractionId === "string",
    );
    const matches: CurrentPendingPermission[] = [];
    // 原因：递归扫整条通知会把旧 payload 伪装成当前审批；仅用已组装快照并关联当前 turn 的 tool row。
    for (const interaction of snapshot.pendingInteractions) {
      if (interaction.kind !== "permission" || interaction.payload.kind !== "permission") continue;
      const permission = interaction as PermissionPendingInteraction;
      const row = rows.find(
        (candidate) =>
          candidate.approvalInteractionId === permission.interactionId &&
          candidate.toolCallId === permission.payload.toolCallId &&
          (permission.anchorRowId === null || permission.anchorRowId === candidate.rowId),
      );
      if (row) matches.push({ interaction: permission, toolRow: row });
    }
    return matches;
  }

  turnHeaders(): Extract<ConversationSnapshot["rows"]["window"][number], { kind: "turnHeader" }>[] {
    return (this.currentSnapshot?.rows.window ?? []).filter(
      (row): row is Extract<typeof row, { kind: "turnHeader" }> => row.kind === "turnHeader",
    );
  }

  waitForChange(afterVersion: number, timeoutMs = 45_000): Promise<number> {
    this.raiseFailure();
    if (this.version > afterVersion) return Promise.resolve(this.version);
    return new Promise((resolvePromise, rejectPromise) => {
      const onChange = (): void => {
        cleanup();
        try {
          this.raiseFailure();
          resolvePromise(this.version);
        } catch (error) {
          rejectPromise(error);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        rejectPromise(new Error("native V4 conversation state did not advance"));
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.changeListeners.delete(onChange);
      };
      this.changeListeners.add(onChange);
    });
  }

  assertHealthy(): void {
    this.raiseFailure();
  }

  reportFailure(error: Error): void {
    this.fail(error);
  }

  private latestTurnId(snapshot: ConversationSnapshot): string | undefined {
    return snapshot.rows.window.findLast((row) => row.kind === "turnHeader")?.turnId;
  }

  private acceptOwnedWire(wire: ConversationTopicWireCandidate): void {
    if (
      wire.topic !== `conversation/${this.sessionId}` ||
      wire.subscriptionId !== this.subscriptionId
    )
      return;
    for (const event of this.assembler.accept(wire)) {
      if (event.kind === "fault") {
        this.fail(
          new Error(`native V4 conversation wire assembly failed: ${event.fault.reasonCode}`),
        );
        return;
      }
      this.applyFrame(event.frame);
    }
  }

  private applyFrame(frame: ConversationTopicFrame): void {
    const topic = `conversation/${this.sessionId}`;
    if (frame.topic !== topic || frame.subscriptionId !== this.subscriptionId)
      throw new Error("native V4 conversation frame does not match the active subscription");
    const current = this.currentSnapshot;
    if (frame.payload.kind === "snapshot") {
      const snapshot = frame.payload.snapshot;
      if (
        frame.fromSeq !== 0 ||
        snapshot.sessionId !== this.sessionId ||
        snapshot.logEpoch !== this.logEpoch ||
        snapshot.seq !== frame.toSeq ||
        (current !== undefined && snapshot.seq < current.seq)
      ) {
        throw new Error("native V4 conversation snapshot has a stale or mismatched identity");
      }
      this.currentSnapshot = snapshot;
      this.changed();
      return;
    }
    if (current && frame.toSeq <= current.seq) return;
    if (!current || current.logEpoch !== this.logEpoch || frame.fromSeq !== current.seq) {
      throw new Error("native V4 conversation delta is not contiguous with current state");
    }
    // 帧区间按 publisher 水位记账；publisher 可 coalesce 多个 operation，不能用 delta 数反推区间长度。
    if (frame.toSeq <= frame.fromSeq) {
      throw new Error("native V4 conversation delta sequence range is invalid");
    }
    this.currentSnapshot = {
      ...applyConversationDeltas(current, frame.payload.deltas),
      seq: frame.toSeq,
    };
    this.changed();
  }

  private changed(): void {
    this.version += 1;
    for (const listener of this.changeListeners) listener();
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const listener of this.changeListeners) listener();
  }

  private raiseFailure(): void {
    if (this.failure) throw this.failure;
  }
}
