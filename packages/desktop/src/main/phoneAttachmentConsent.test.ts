import assert from "node:assert/strict";
import { test } from "node:test";
import { createPhoneAttachmentConsent } from "./phoneAttachmentConsent.js";

const origin = "http://127.0.0.1:18191";
const scope = { windowId: 7, workspacePath: "/same", workspaceIdentity: "remote:a", origin };

test("default off; one-use bounded pair and exact origin/Host/identity", () => {
  let host: object | undefined = {};
  let now = 10_000;
  let forwarded = 0;
  const authority = createPhoneAttachmentConsent({
    currentHost: () => host,
    clock: () => now,
    randomSecret: () => `secret-${++forwarded}-${"x".repeat(40)}`,
  });
  assert.throws(() => authority.beginConsent(scope), /disabled/);
  authority.setEnabled(true);
  const challenge = authority.beginConsent(scope);
  assert.throws(() => authority.pair({ ...scope, challenge: "wrong" }), /denied/);
  assert.throws(
    () => authority.pair({ ...scope, origin: "http://evil.example", challenge }),
    /denied/,
  );
  const credential = authority.pair({ ...scope, challenge });
  assert.throws(() => authority.pair({ ...scope, challenge }), /denied/);
  assert.throws(
    () => authority.attach({ ...scope, workspaceIdentity: "remote:b", credential }, () => {}),
    /denied/,
  );
  assert.throws(() => authority.attach({ ...scope, credential: "forged" }, () => {}), /denied/);
  let closed = 0;
  authority.attach({ ...scope, credential }, () => {
    closed++;
  });
  host = {};
  assert.throws(() => authority.attach({ ...scope, credential }, () => {}), /denied/);
  assert.equal(closed, 1);
  now += 121_000;
  assert.throws(() => authority.attach({ ...scope, credential }, () => {}), /denied/);
});

test("expiration, bounded attempts, live revoke and disable close active view, without owner effects", () => {
  let now = 0;
  const host = {};
  const authority = createPhoneAttachmentConsent({
    currentHost: () => host,
    clock: () => now,
  });
  authority.setEnabled(true);
  const expired = authority.beginConsent(scope);
  now += 121_000;
  assert.throws(() => authority.pair({ ...scope, challenge: expired }), /denied/);
  const locked = authority.beginConsent(scope);
  for (let i = 0; i < 5; i++)
    assert.throws(() => authority.pair({ ...scope, challenge: "invalid" }), /denied/);
  assert.throws(() => authority.pair({ ...scope, challenge: locked }), /denied/);
  const credential = authority.pair({ ...scope, challenge: authority.beginConsent(scope) });
  let closed = 0;
  authority.attach({ ...scope, credential }, () => {
    closed++;
  });
  authority.revoke(credential);
  assert.equal(closed, 1);
  assert.throws(() => authority.attach({ ...scope, credential }, () => {}), /denied/);
  const next = authority.pair({ ...scope, challenge: authority.beginConsent(scope) });
  authority.attach({ ...scope, credential: next }, () => {
    closed++;
  });
  authority.setEnabled(false);
  assert.equal(closed, 2);
  assert.throws(() => authority.attach({ ...scope, credential: next }, () => {}), /disabled/);
});

test("origin policy refuses nonloopback cleartext and credential cannot authorize another window", () => {
  const host = {};
  const authority = createPhoneAttachmentConsent({ currentHost: () => host });
  authority.setEnabled(true);
  assert.throws(() => authority.beginConsent({ ...scope, origin: "http://example.test" }), /TLS/);
  const credential = authority.pair({ ...scope, challenge: authority.beginConsent(scope) });
  assert.throws(() => authority.attach({ ...scope, windowId: 8, credential }, () => {}), /denied/);
  authority.revokeWindow(7);
  assert.throws(() => authority.attach({ ...scope, credential }, () => {}), /denied/);
});
