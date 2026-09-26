import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
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
  /** Same-child synthetic request mutation at the ExecutionPort, never a product setting. */
  fakeExecFault?: "shell-profile" | "shell-override" | "inherited-path";
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
      if (input.fakeExecFault === "inherited-path") {
        // 即使环境 PATH 被错误继承，也不得让 shell 解析另一个 node。
        request = { ...request, env: { base: "inherit", set: { PATH: input.cwd } } };
      }
      if (input.fakeExecFault === "shell-profile" && request.command.mode === "shell")
        request = { ...request, command: { ...request.command, shellProfile: undefined } };
      if (input.fakeExecFault === "shell-override" && request.command.mode === "shell")
        request = { ...request, command: { ...request.command, shell: "/bin/sh" } };
      if (
        phase !== 2 ||
        request.cwd !== input.cwd ||
        request.command.mode !== "shell" ||
        request.command.command !== input.bashCommand ||
        request.command.shellProfile !== "posix-bash" ||
        request.command.shell !== undefined ||
        (request.command.shellOverride !== undefined &&
          (request.command.shellOverride.source !== "auto-detected" &&
           request.command.shellOverride.source !== "legacy-fallback")) ||
        (request.bashPrelude !== undefined && request.bashPrelude.kind !== "embedded-search") ||
        request.stdin !== undefined ||
        request.env !== undefined ||
        request.sandbox?.enabled !== true ||
        request.sandbox.dangerouslyDisableSandbox === true
      )
        return reject();
      // 修复：命令文本相同不保证 PATH 解析同一个 node；固定当前 Node 24 二进制、
      // 脚本字节和隔离 cwd，再借用现有执行端口。此处不是通用 shell 沙箱。
      if (!/^v24\./u.test(process.version) ||
          (await realpath(join(input.cwd, "verify.cjs"))) !== join(input.cwd, "verify.cjs") ||
          (await readFile(join(input.cwd, "verify.cjs"), "utf8")) !==
            "require('node:fs').writeFileSync('bash-effect.txt', 'bash-verified|' + process.execPath); console.log('exit=0')\n")
        return reject();
      // 已验证唯一脚本和固定二进制后借用原执行 adapter 的 argv 模式，彻底绕开
      // login shell / profile / PATH 解析；此证明仅限这一个已知 fixture。
      return exec.run({ ...request, bashPrelude: undefined, command: { mode: "argv", file: nodeBinary, args: ["verify.cjs"] } },
        options);
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
