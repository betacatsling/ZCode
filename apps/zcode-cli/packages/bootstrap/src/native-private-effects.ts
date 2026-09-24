import { readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
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
  const nodeBinary = process.execPath;
  const exec = createNodeExecutionAdapter({
    processEnv: { PATH: [dirname(nodeBinary), input.processEnv.PATH ?? ""].join(delimiter), HOME: input.processEnv.HOME },
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
      // 修复：命令文本相同不保证 PATH 解析同一个 node；固定当前 Node 24 二进制、
      // 脚本字节和隔离 cwd，再借用现有执行端口。此处不是通用 shell 沙箱。
      if (!/^v24\./u.test(process.version) ||
          (await realpath(join(input.cwd, "verify.cjs"))) !== join(input.cwd, "verify.cjs") ||
          (await readFile(join(input.cwd, "verify.cjs"), "utf8")) !==
            "require('node:fs').writeFileSync('bash-effect.txt', 'bash-verified|' + process.execPath); console.log('exit=0')\n")
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
