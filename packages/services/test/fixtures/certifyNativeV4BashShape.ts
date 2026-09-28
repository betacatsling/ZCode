import { resolve } from "node:path";
import { isNativeCheckCommand, nativeFixtureRelativePath } from "./certifyNativeV4Common.js";

type NativeCommandHead =
  | "node"
  | "bash"
  | "sh"
  | "cd"
  | "cat"
  | "ls"
  | "grep"
  | "sed"
  | "head"
  | "tail"
  | "pwd"
  | "echo"
  | "python"
  | "python3"
  | "git"
  | "other";
type NativeShellOperator =
  | "and"
  | "or"
  | "sequence"
  | "pipe"
  | "redirect-output"
  | "append-output"
  | "redirect-input"
  | "background"
  | "command-substitution";

export interface NativeBashCommandShape {
  readonly head: NativeCommandHead | "missing";
  readonly knownFixturePaths: readonly (
    | "input.txt"
    | "output.txt"
    | "check.mjs"
    | ".native-check-success"
    | "workspace-root"
  )[];
  readonly otherFixturePathCount: number;
  readonly outsideFixturePathCount: number;
  readonly operatorKinds: readonly NativeShellOperator[];
  readonly tokenCount: number;
  readonly parseStatus: "complete" | "unclosed-quote" | "truncated";
}

export type NativeCommandMismatchReason =
  | "command-shape-unparseable"
  | "shell-operator-present"
  | "head-not-node"
  | "fixed-check-path-missing"
  | "extra-command-arguments"
  | "unsupported-spelling";

const maximumCommandShapeLength = 4_096;
const knownCommandHeads = new Set<NativeCommandHead>([
  "node",
  "bash",
  "sh",
  "cd",
  "cat",
  "ls",
  "grep",
  "sed",
  "head",
  "tail",
  "pwd",
  "echo",
  "python",
  "python3",
  "git",
]);
const knownFixtureFiles = new Set([
  "input.txt",
  "output.txt",
  "check.mjs",
  ".native-check-success",
]);

function tokenizeCommandShape(command: string): {
  readonly tokens: readonly string[];
  readonly operators: readonly NativeShellOperator[];
  readonly parseStatus: NativeBashCommandShape["parseStatus"];
} {
  const source = command.slice(0, maximumCommandShapeLength);
  const tokens: string[] = [];
  const operators = new Set<NativeShellOperator>();
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = (): void => {
    if (current) tokens.push(current);
    current = "";
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\n") {
      flush();
      operators.add("sequence");
      continue;
    }
    if (/\s/u.test(character)) {
      flush();
      continue;
    }
    if (character === "$" && source[index + 1] === "(") {
      flush();
      operators.add("command-substitution");
      index += 1;
      continue;
    }
    if (character === "`") {
      flush();
      operators.add("command-substitution");
      continue;
    }
    if (character === "&" && source[index + 1] === "&") {
      flush();
      operators.add("and");
      index += 1;
      continue;
    }
    if (character === "|" && source[index + 1] === "|") {
      flush();
      operators.add("or");
      index += 1;
      continue;
    }
    if (character === ">" && source[index + 1] === ">") {
      flush();
      operators.add("append-output");
      index += 1;
      continue;
    }
    if (character === ";" || character === "|") {
      flush();
      operators.add(character === ";" ? "sequence" : "pipe");
      continue;
    }
    if (character === ">" || character === "<" || character === "&") {
      flush();
      operators.add(
        character === ">" ? "redirect-output" : character === "<" ? "redirect-input" : "background",
      );
      continue;
    }
    current += character;
  }
  flush();
  const parseStatus =
    source.length !== command.length
      ? "truncated"
      : quote || escaped
        ? "unclosed-quote"
        : "complete";
  return { tokens, operators: [...operators], parseStatus };
}

function commandHead(token: string | undefined): NativeCommandHead | "missing" {
  if (!token) return "missing";
  const basename = token.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
  const normalized = basename.replace(/\.(?:exe|cmd)$/u, "");
  return knownCommandHeads.has(normalized as NativeCommandHead)
    ? (normalized as NativeCommandHead)
    : "other";
}

function isPathLikeCommandToken(token: string): boolean {
  return (
    token.includes("/") ||
    token.includes("\\") ||
    token.startsWith(".") ||
    /\.(?:txt|mjs)$/iu.test(token)
  );
}

export function analyzeNativeBashCommand(
  command: string,
  workspace: string,
): {
  readonly fixedCheck: boolean;
  readonly shape: NativeBashCommandShape;
  readonly mismatchReason?: NativeCommandMismatchReason;
} {
  const parsed = tokenizeCommandShape(command);
  const head = commandHead(parsed.tokens[0]);
  const knownFixturePaths = new Set<NativeBashCommandShape["knownFixturePaths"][number]>();
  let otherFixturePathCount = 0;
  let outsideFixturePathCount = 0;
  for (const token of parsed.tokens.slice(1)) {
    if (!isPathLikeCommandToken(token)) continue;
    if (resolve(token) === resolve(workspace)) {
      knownFixturePaths.add("workspace-root");
      continue;
    }
    const relativePath = nativeFixtureRelativePath(token, workspace);
    if (relativePath === undefined) {
      outsideFixturePathCount += 1;
    } else if (knownFixtureFiles.has(relativePath)) {
      knownFixturePaths.add(relativePath as NativeBashCommandShape["knownFixturePaths"][number]);
    } else {
      otherFixturePathCount += 1;
    }
  }
  const fixedCheck = isNativeCheckCommand(command, workspace);
  const shape: NativeBashCommandShape = {
    head,
    knownFixturePaths: [...knownFixturePaths],
    otherFixturePathCount,
    outsideFixturePathCount,
    operatorKinds: parsed.operators,
    tokenCount: parsed.tokens.length,
    parseStatus: parsed.parseStatus,
  };
  if (fixedCheck) return { fixedCheck, shape };
  const mismatchReason: NativeCommandMismatchReason =
    parsed.parseStatus !== "complete"
      ? "command-shape-unparseable"
      : parsed.operators.length > 0
        ? "shell-operator-present"
        : head !== "node"
          ? "head-not-node"
          : !knownFixturePaths.has("check.mjs")
            ? "fixed-check-path-missing"
            : parsed.tokens.length > 2
              ? "extra-command-arguments"
              : "unsupported-spelling";
  return { fixedCheck, shape, mismatchReason };
}
