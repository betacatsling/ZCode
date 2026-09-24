import { readFile, readdir, realpath } from "node:fs/promises";
import { delimiter, dirname } from "node:path";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import type { ExecutionPort, ExecutionRequest, FileSystemPort } from "@zcode/contracts";
import {
  PRIVATE_SHELL_SCRIPT,
  privateShellCommand,
  privateShellScriptPath,
} from "./native-private-shell-fixture.js";

const TRUSTED_SHELL = "/bin/bash";
const TRUSTED_SYSTEM_PATH = ["/usr/bin", "/bin"].join(delimiter);

type FixtureFault =
  | "shell-profile"
  | "shell-override"
  | "inherited-path"
  | "shell-dialect"
  | "shell-foreign-path"
  | "shell-source"
  | "foreign-home"
  | "prelude-command"
  | "prelude-args"
  | "prelude-env"
  | "stdin"
  | "unsafe-sandbox"
  | "script-mismatch"
  | "cwd-mismatch"
  | "prelude-binary"
  | "profile-startup"
  | "prelude-drop"
  | "prelude-extra-env";

// Test-only mutations at the pre-effect port: each must be rejected before adapter I/O.
function mutateRequest(request: ExecutionRequest, fault?: FixtureFault): ExecutionRequest {
  const command = request.command;
  switch (fault) {
    case "shell-profile":
      return command.mode === "shell"
        ? { ...request, command: { ...command, shellProfile: undefined } }
        : request;
    case "shell-override":
      return command.mode === "shell"
        ? { ...request, command: { ...command, shell: "/bin/sh" } }
        : request;
    case "shell-dialect":
      return command.mode === "shell"
        ? {
            ...request,
            command: {
              ...command,
              shellOverride: {
                dialect: "cmd",
                path: TRUSTED_SHELL,
                source: "auto-detected",
                display: { name: "bash" },
              },
            },
          }
        : request;
    case "shell-foreign-path":
      return command.mode === "shell"
        ? {
            ...request,
            command: {
              ...command,
              shellOverride: {
                dialect: "posix",
                path: "/bin/sh",
                source: "auto-detected",
                display: { name: "bash" },
              },
            },
          }
        : request;
    case "shell-source":
      return command.mode === "shell"
        ? {
            ...request,
            command: {
              ...command,
              shellOverride: {
                dialect: "posix",
                path: TRUSTED_SHELL,
                source: "user-config",
                display: { name: "bash" },
              },
            },
          }
        : request;
    case "inherited-path":
      return { ...request, env: { base: "inherit", set: { PATH: request.cwd ?? "" } } };
    case "foreign-home":
      return { ...request, env: { set: { HOME: request.cwd ?? "" } } };
    case "prelude-command":
      return {
        ...request,
        bashPrelude: {
          kind: "embedded-search",
          backend: { kind: "internal-cli", command: "/bin/sh", args: ["__internal-search"] },
        },
      };
    case "prelude-drop":
      return { ...request, bashPrelude: undefined };
    case "prelude-extra-env": {
      if (!request.bashPrelude) return request;
      const backend = Object.assign({}, request.bashPrelude.backend, { env: { FOREIGN: "1" } });
      return { ...request, bashPrelude: { ...request.bashPrelude, backend } };
    }
    case "prelude-binary":
      return {
        ...request,
        bashPrelude: {
          kind: "embedded-search",
          backend: {
            kind: "native-binaries",
            findCommand: "/bin/sh",
            grepCommand: "ugrep",
            rgCommand: "rg",
          },
          findAndGrepEnabled: false,
        },
      };
    case "prelude-args":
      return {
        ...request,
        bashPrelude: {
          kind: "embedded-search",
          backend: { kind: "internal-cli", command: process.execPath, args: ["foreign"] },
        },
      };
    case "prelude-env":
      return {
        ...request,
        bashPrelude: {
          kind: "embedded-search",
          backend: {
            kind: "internal-cli",
            command: process.execPath,
            args: ["__internal-search"],
            env: { FOREIGN: "1" },
          },
        },
      };
    case "stdin":
      return { ...request, stdin: "foreign" };
    case "unsafe-sandbox":
      return { ...request, sandbox: { enabled: false, dangerouslyDisableSandbox: true } };
    case "cwd-mismatch":
      return { ...request, cwd: dirname(request.cwd ?? "") };
    default:
      return request;
  }
}

function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join("\0") === keys.sort().join("\0");
}

function trustedPrelude(request: ExecutionRequest): boolean {
  const prelude = request.bashPrelude;
  if (prelude === undefined) return false;
  // Only the default isolated runtime backend is allowed. No externally configured command,
  // argv, env or backend binary may enter the shell startup script.
  if (
    prelude.kind !== "embedded-search" ||
    prelude.findAndGrepEnabled !== false ||
    !exactKeys(prelude, ["kind", "backend", "findAndGrepEnabled"])
  )
    return false;
  const backend = prelude.backend;
  return (
    backend.kind === "native-binaries" &&
    exactKeys(backend, ["kind", "findCommand", "grepCommand", "rgCommand"]) &&
    backend.findCommand === "bfs" &&
    backend.grepCommand === "ugrep" &&
    backend.rgCommand === "rg"
  );
}

export function createPrivateEffectPorts(input: {
  cwd: string;
  readPath: string;
  writePath: string;
  writeContent: string;
  bashCommand: string;
  processEnv: NodeJS.ProcessEnv;
  fakeExecFault?: FixtureFault;
  onShellObservation?: (fact: {
    selectionTrusted: boolean;
    preludeTrusted: boolean;
    envTrusted: boolean;
    scriptTrusted: boolean;
    forwarded: boolean;
    backendKind: string;
    findAndGrepEnabled: boolean | null;
    backendDefaults: boolean[];
  }) => void;
}): {
  fileSystemPort: FileSystemPort;
  executionPort: ExecutionPort;
  setPhase: (phase: 1 | 2 | 3) => void;
  dispose: () => Promise<void>;
} {
  let phase = 0;
  const fs = createNodeFileSystemAdapter();
  const nodeBinary = process.execPath;
  const trustedEnv = {
    PATH: [dirname(nodeBinary), TRUSTED_SYSTEM_PATH].join(delimiter),
    HOME: input.processEnv.HOME,
    SHELL: TRUSTED_SHELL,
  };
  const exec = createNodeExecutionAdapter({ processEnv: trustedEnv, outputRootDir: input.cwd });
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
    async run(original, options) {
      const request = mutateRequest(original, input.fakeExecFault);
      const shell = request.command.mode === "shell" ? request.command.shellOverride : undefined;
      const selectionTrusted =
        shell?.source === "auto-detected" &&
        shell.dialect === "posix" &&
        shell.path === TRUSTED_SHELL &&
        shell.id === "auto:bash" &&
        shell.label === "bash" &&
        shell.display.name === "bash" &&
        exactKeys(shell, ["id", "label", "path", "dialect", "source", "display"]) &&
        exactKeys(shell.display, ["name"]);
      const preludeTrusted = trustedPrelude(request);
      const envTrusted =
        trustedEnv.HOME === dirname(input.cwd) &&
        input.processEnv.PATH === trustedEnv.PATH &&
        input.processEnv.SHELL === TRUSTED_SHELL;
      const observe = (scriptTrusted: boolean, forwarded: boolean) =>
        input.onShellObservation?.({
          selectionTrusted,
          preludeTrusted,
          envTrusted,
          scriptTrusted,
          forwarded,
          backendKind: request.bashPrelude?.backend.kind ?? "absent",
          findAndGrepEnabled: request.bashPrelude?.findAndGrepEnabled ?? null,
          backendDefaults:
            request.bashPrelude?.backend.kind === "native-binaries"
              ? [
                  request.bashPrelude.backend.findCommand === "bfs",
                  request.bashPrelude.backend.grepCommand === "ugrep",
                  request.bashPrelude.backend.rgCommand === "rg",
                ]
              : [],
        });
      if (
        phase !== 2 ||
        process.platform !== "darwin" ||
        request.cwd !== input.cwd ||
        request.command.mode !== "shell" ||
        request.command.command !== input.bashCommand ||
        input.bashCommand !== privateShellCommand(nodeBinary) ||
        request.command.shellProfile !== "posix-bash" ||
        request.command.shell !== undefined ||
        !selectionTrusted ||
        !preludeTrusted ||
        request.stdin !== undefined ||
        request.env !== undefined ||
        request.sandbox?.enabled !== true ||
        request.sandbox.dangerouslyDisableSandbox === true ||
        !envTrusted ||
        !process.version.startsWith("v24.")
      ) {
        observe(false, false);
        return reject();
      }
      const script = privateShellScriptPath(input.cwd);
      if (
        (await realpath(input.cwd)) !== input.cwd ||
        (await realpath(script)) !== script ||
        (await readFile(script, "utf8")) !== PRIVATE_SHELL_SCRIPT ||
        (await readdir(dirname(input.cwd))).some((name) => /^\.(?:bash|profile|zsh)/u.test(name)) ||
        !nodeBinary.startsWith("/") ||
        (await realpath(nodeBinary)) !== nodeBinary
      ) {
        observe(false, false);
        return reject();
      }
      observe(true, true);
      // 修复：argv 替换会丢失赋值、profile/prelude 和 cwd 捕获；仅验证 fixture，
      // 将原请求不变交给真实 shell adapter，不能代替或伪造其 spawn 回执。
      return exec.run(request, options);
    },
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
