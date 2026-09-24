import assert from "node:assert/strict";
import { test } from "node:test";
import { selectDesktopTsupConfigs } from "./desktop-tsup-part-selector.mjs";

const configs = ["main", "preload", "host", "scheduler"].map((name) => ({ name }));

test("normal desktop build retains all four ordered configs", () => {
  assert.deepEqual(selectDesktopTsupConfigs(configs, undefined), configs);
});

for (const part of ["main", "preload", "host", "scheduler"]) {
  test(`direct desktop build of ${part} selects precisely one`, () => {
    assert.deepEqual(selectDesktopTsupConfigs(configs, part), [
      configs.find((c) => c.name === part),
    ]);
  });
}

test("unknown, empty, and duplicate selectors fail closed", () => {
  for (const part of ["", "MAIN", "main,host", "other", " main "]) {
    assert.throws(() => selectDesktopTsupConfigs(configs, part), /ZCODE_DESKTOP_BUILD_PART/);
  }
  assert.throws(() => selectDesktopTsupConfigs([...configs, configs[0]], "main"), /exactly one/);
});
