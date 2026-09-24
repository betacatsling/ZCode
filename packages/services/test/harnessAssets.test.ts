import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { iconAssetIdSchema } from "@zcode/shared/agent-host";
import {
  nativeHarnessAssetMetadata,
  harnessAssetPackagePaths,
  resolveHarnessAsset,
  validateTrustedPng,
} from "../src/harness-assets/index.js";

const png = await readFile(new URL("../src/harness-assets/assets/zcode.png", import.meta.url));
const piPng = await readFile(new URL("../src/harness-assets/assets/pi.png", import.meta.url));

test("fixed trusted mapping serves only bounded packaged PNG, metadata is not execution registry", async () => {
  assert.equal(validateTrustedPng(png).mimeType, "image/png");
  assert.deepEqual(nativeHarnessAssetMetadata.zcode.icon, {
    light: "builtin:zcode",
    dark: "builtin:zcode",
  });
  assert.deepEqual(nativeHarnessAssetMetadata.pi.icon, {
    light: "builtin:pi",
    dark: "builtin:pi",
  });
  for (const id of ["codex", "claude"]) {
    assert.equal(nativeHarnessAssetMetadata[id]?.icon, undefined);
  }
  assert.deepEqual(harnessAssetPackagePaths, ["assets/zcode.png", "assets/pi.png"]);
  assert.deepEqual(validateTrustedPng(piPng), { mimeType: "image/png", width: 128, height: 128 });
  assert.equal(
    createHash("sha256").update(piPng).digest("hex"),
    "0f8e0daa6f0f44f316bf7e1dfe5b6a3735077e4885af899967480c8cdd4ba286",
  );
  const piAsset = await resolveHarnessAsset("builtin:pi");
  assert.deepEqual(Buffer.from(piAsset!.base64, "base64"), piPng);
  const resource = await resolveHarnessAsset("builtin:zcode");
  assert.equal(resource?.kind, "trusted-png");
  assert.deepEqual(Buffer.from(resource!.base64, "base64"), png);
  for (const id of [
    "builtin:missing",
    "builtin:pi/../../secret",
    "builtin:pi.png",
    "https://evil/icon.svg",
    "../secret",
    "builtin:../../secret",
    "data:image/png;base64,AAAA",
  ]) {
    assert.equal(await resolveHarnessAsset(id), undefined);
  }
  assert.equal(iconAssetIdSchema.safeParse("builtin:zcode").success, true);
  for (const path of harnessAssetPackagePaths) {
    const packaged = await readFile(new URL(`../src/harness-assets/${path}`, import.meta.url));
    assert.ok(packaged.byteLength < 256 * 1024);
    validateTrustedPng(packaged);
  }
});

test("invalid, oversized, truncated and malicious SVG bytes fail closed", () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://evil.test/collect"/></svg>',
  );
  for (const bytes of [
    svg,
    Buffer.alloc(256 * 1024 + 1),
    png.subarray(0, 35),
    Buffer.concat([png, svg]),
  ]) {
    assert.throws(() => validateTrustedPng(bytes));
  }
  const invalidDimensions = Buffer.from(png);
  invalidDimensions.writeUInt32BE(4096, 16);
  assert.throws(() => validateTrustedPng(invalidDimensions));
  const badChunk = Buffer.from(png);
  badChunk.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => validateTrustedPng(badChunk));
  const badCrc = Buffer.from(piPng);
  badCrc[8 + 8 + 13] ^= 1; // IHDR checksum only, dimensions unchanged
  assert.throws(() => validateTrustedPng(badCrc));
  const duplicateEnd = Buffer.concat([piPng, piPng.subarray(piPng.length - 12)]);
  assert.throws(() => validateTrustedPng(duplicateEnd));
});
