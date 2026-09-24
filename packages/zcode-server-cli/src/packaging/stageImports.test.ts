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
    const docs = '"from", ", "';
  `);
  assert.deepEqual([...imports].sort(), ["@scope/real", "dynamic-real", "real-export"]);
});

test("stager recognizes actual CJS require and literal dynamic import without scanning docs", async () => {
  const imports = await collectBareModuleSpecifiers(
    `
    const real = require("real-cjs");
    const dynamic = import("dynamic-cjs");
    const native = require2("node-pty/lib/utils");
    const docs = "require('fake-doc')";
    const codeExample = "import('fake-example')";
    const data = import("data:text/javascript,export%20default%201");
  `,
    true,
  );
  assert.deepEqual([...imports].sort(), ["dynamic-cjs", "node-pty", "real-cjs"]);
});
