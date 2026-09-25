import assert from "node:assert/strict";
import { test } from "node:test";
import { collectBareModuleSpecifiers } from "./stage.js";

test("stager recognizes executable ESM imports and ignores inline SDK documentation", async () => {
  const imports = await collectBareModuleSpecifiers(`
    import api from "@scope/real";
    export { task } from "real-export";
    const lazy = import("dynamic-real");
    const standard = import("node:sqlite");
    const embedded = "import {remark} from 'remark'";
    var require2 = createRequire(import.meta.url);
    const native = require2("node-pty/lib/utils");
    const bundled = __require("generated-runtime");
    function require5(value) { return value; }
    const shadowed = require5("shadowed-not-a-package");
    const docs = '"from", ", "';
  `);
  assert.deepEqual([...imports].sort(), [
    "@scope/real",
    "dynamic-real",
    "generated-runtime",
    "node-pty",
    "real-export",
  ]);
});

test("stager resolves generated require alias despite actual ESM createRequire banner", async () => {
  const imports = await collectBareModuleSpecifiers(`
    import { createRequire as __zcodeCreateRequire } from "node:module";
    import { createRequire } from "node:module";
    const require = __zcodeCreateRequire(import.meta.url);
    var require2 = createRequire(import.meta.url);
    const native = require2("node-pty/lib/utils");
    const fake = "require2('quoted-not-runtime')";
    function require5(value) { return value; }
    const shadowed = require5("shadowed-not-a-package");
    const bundled = __require("generated-runtime");
  `);
  assert.deepEqual([...imports].sort(), ["generated-runtime", "node-pty"]);
});

test("stager fails closed for an unrecognized shadowed root require", async () => {
  await assert.rejects(
    collectBareModuleSpecifiers('const require = customLoader; require("unknown-package");'),
    /Unrecognized release bundle require binding/,
  );
});

test("stager recognizes actual CJS require and literal dynamic import without scanning docs", async () => {
  const imports = await collectBareModuleSpecifiers(
    `
    const real = require("real-cjs");
    const dynamic = import("dynamic-cjs");
    const docs = "require('fake-doc')";
    const codeExample = "import('fake-example')";
    const data = import("data:text/javascript,export%20default%201");
  `,
    true,
  );
  assert.deepEqual([...imports].sort(), ["dynamic-cjs", "real-cjs"]);
});
