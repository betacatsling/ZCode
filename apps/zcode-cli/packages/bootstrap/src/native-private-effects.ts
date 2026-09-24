import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";

// 可信 Node 测试装配：借用现有 I/O adapters，不模拟工具/Model executor。
// Read 在 CLI 可免权限，因此仅有交互 permission gate 并不足以限制 Read 的真实文件副作用。
export function createPrivateEffectPorts(input: {
  cwd: string;
  readPath: string;
  writePath: string;
  writeContent: string;
  bashCommand: string;
  processEnv: NodeJS.ProcessEnv;
}): {
  fileSystemPort: FileSystemPort;
  executionPort: ExecutionPort;
  setPhase: (phase: 1 | 2 | 3) => void;
  dispose: () => Promise<void>;
} {
  let phase = 0;
  const fs = createNodeFileSystemAdapter();
  const exec = createNodeExecutionAdapter({
    processEnv: { PATH: input.processEnv.PATH, HOME: input.processEnv.HOME },
    outputRootDir: input.cwd,
  });
  const reject = (): never => {
    throw new Error("private fixture effect scope denied");
  };
  const fileSystemPort: FileSystemPort = {
    async readTextFileRange(request, options) {
      if (request.path !== input.readPath || (phase !== 1 && phase !== 3)) return reject();
      return fs.readTextFileRange(request, options);
    },
    async readTextFile(request) {
      if (
        (request.path !== input.readPath && request.path !== input.writePath) ||
        (request.path === input.writePath && phase !== 2) ||
        (request.path === input.readPath && phase !== 1 && phase !== 3)
      )
        return reject();
      return fs.readTextFile(request);
    },
    readBinaryFile: async () => reject(),
    async writeTextFile(request) {
      if (phase !== 2 || request.path !== input.writePath || request.content !== input.writeContent)
        return reject();
      return fs.writeTextFile(request);
    },
    async stat(request) {
      if (
        request.path !== input.cwd &&
        !(request.path === input.readPath && (phase === 1 || phase === 3)) &&
        !(request.path === input.writePath && phase === 2)
      )
        return reject();
      return fs.stat(request);
    },
    createDirectory: async () => reject(),
    removeFile: async () => reject(),
    listDirectory: async () => reject(),
    searchFiles: async () => reject(),
    searchText: async () => reject(),
  };
  const executionPort: ExecutionPort = {
    async run(request, options) {
      if (
        phase !== 2 ||
        request.cwd !== input.cwd ||
        request.command.mode !== "shell" ||
        request.command.command !== input.bashCommand ||
        (request.bashPrelude && request.bashPrelude.kind !== "embedded-search") ||
        request.stdin !== undefined ||
        request.env !== undefined ||
        request.sandbox?.dangerouslyDisableSandbox === true
      )
        return reject();
      return exec.run(request, options);
    },
    // 禁止 auto-background、额外进程、输出检索或注册表动作；只借用 foreground run。
  };
  return {
    fileSystemPort,
    executionPort,
    setPhase(next) {
      phase = next;
    },
    dispose: async () => {
      await exec.close?.();
    },
  };
}
