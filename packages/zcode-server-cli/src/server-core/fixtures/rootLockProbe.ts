import { DataRootLock } from "../../runtime/lock.js";
import { resolveServerLayout } from "../../runtime/paths.js";

const serverRoot = process.argv[2];
if (!serverRoot) throw new Error("missing server root");
const lock = new DataRootLock(resolveServerLayout(serverRoot).lockFile);
void lock
  .acquire()
  .then(async () => {
    await lock.release();
    process.send?.({ status: "acquired" }, () => process.exit(0));
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.send?.({ status: "blocked", message }, () => process.exit(0));
  });
