import type { RepositoryBinding } from "./planTypes.js";
import { ProjectWorkspaceError } from "./errors.js";

export interface ResolveRepositoryBindingInput {
  bindings: readonly RepositoryBinding[];
  projectId: string;
  executionTargetId: string;
  gitCommonDir: string;
  /** 只作为调用方误传的定位信息。解析绝不按 origin URL 合并 clone。 */
  originUrl?: string | null;
  allocateId: () => string;
}

/**
 * 同一 execution target 上、同一个 git common directory 才是同一个 binding。
 * 另一台主机上的相同路径、或 origin 相同的另一份 clone，都是新 binding。
 */
export function resolveRepositoryBinding(input: ResolveRepositoryBindingInput): {
  binding: RepositoryBinding;
  created: boolean;
} {
  void input.originUrl;
  const existing = input.bindings.find(
    (binding) =>
      binding.executionTargetId === input.executionTargetId &&
      binding.gitCommonDir === input.gitCommonDir,
  );
  if (existing) {
    if (existing.projectId !== input.projectId) {
      throw new ProjectWorkspaceError("binding-owned-by-other-project");
    }
    return { binding: existing, created: false };
  }
  return {
    created: true,
    binding: {
      id: input.allocateId(),
      projectId: input.projectId,
      executionTargetId: input.executionTargetId,
      gitCommonDir: input.gitCommonDir,
    },
  };
}
