/** Coalesces summary events without a trailing timer that can be reset forever. */
export class ProjectSidebarSummaryRefreshScheduler {
  private readonly pendingWorkspaceIds = new Set<string>();
  private flight: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly refresh: (workspaceIds: readonly string[]) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  request(workspaceIds: readonly string[]): void {
    if (this.disposed) return;
    for (const workspaceId of workspaceIds) {
      if (workspaceId) this.pendingWorkspaceIds.add(workspaceId);
    }
    this.start();
  }

  async whenIdle(): Promise<void> {
    while (this.flight) await this.flight;
  }

  dispose(): void {
    this.disposed = true;
    this.pendingWorkspaceIds.clear();
  }

  private start(): void {
    if (this.disposed || this.flight || this.pendingWorkspaceIds.size === 0) return;
    const flight = this.drain()
      .catch((error: unknown) => this.onError(error))
      .finally(() => {
        if (this.flight !== flight) return;
        this.flight = null;
        this.start();
      });
    this.flight = flight;
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.pendingWorkspaceIds.size > 0) {
      const workspaceIds = [...this.pendingWorkspaceIds].sort((left, right) =>
        left.localeCompare(right),
      );
      this.pendingWorkspaceIds.clear();
      await this.refresh(workspaceIds);
    }
  }
}
