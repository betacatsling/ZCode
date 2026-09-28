import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const CREDENTIAL_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".config", "credentials"]);

/** 演练只能落在临时目录。不碰用户主目录、日常会话和凭据。 */
export function assertIsolatedDrillRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error("drill-root-must-be-absolute");
  const resolved = resolve(root);
  const temp = resolve(tmpdir());
  const home = resolve(homedir());
  const under = (parent: string, child: string): boolean => {
    const fromParent = relative(parent, child);
    return fromParent.length > 0 && !fromParent.startsWith("..") && !isAbsolute(fromParent);
  };
  if (resolved === home || under(home, resolved)) throw new Error("drill-refuses-user-home");
  if (!under(temp, resolved)) throw new Error("drill-root-must-be-under-tmpdir");
  for (const segment of resolved.split(sep)) {
    if (
      CREDENTIAL_SEGMENTS.has(segment) ||
      segment.includes("id_rsa") ||
      segment.includes("credential")
    ) {
      throw new Error("drill-refuses-credential-path");
    }
  }
  return resolved;
}
