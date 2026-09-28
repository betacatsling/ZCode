export interface ProjectSidebarRequestContext {
  readonly workspaceScopeKey: string;
  readonly remoteSessionId: string | null;
  readonly connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  readonly services: object;
}

export interface ProjectSidebarRequestToken {
  readonly generation: number;
  readonly context: ProjectSidebarRequestContext;
}

/** Rejects late async work after the workspace, remote attachment or Host instance changes. */
export class ProjectSidebarRequestFence {
  private generation = 0;
  private current: ProjectSidebarRequestToken | null = null;

  activate(context: ProjectSidebarRequestContext): ProjectSidebarRequestToken {
    const previous = this.current?.context;
    if (
      !previous ||
      previous.workspaceScopeKey !== context.workspaceScopeKey ||
      previous.remoteSessionId !== context.remoteSessionId ||
      previous.connectionKind !== context.connectionKind ||
      previous.services !== context.services
    ) {
      this.generation += 1;
      this.current = Object.freeze({ generation: this.generation, context });
    }
    return this.current!;
  }

  isCurrent(token: ProjectSidebarRequestToken): boolean {
    return this.current === token;
  }
}
