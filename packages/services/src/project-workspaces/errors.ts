export class ProjectWorkspaceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "ProjectWorkspaceError";
    this.code = code;
  }
}

export function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
