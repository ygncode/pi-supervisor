import assert from "node:assert/strict";
import type { PaneClassification } from "./classifier";
import {
  automaticCloseBlockReason,
  explicitCloseBlockReason,
  legacyCleanupBlockReason,
  settledAtFromSignal,
  type SessionLifecycleInput,
} from "./lifecycle";

const now = 2_000_000;
const clean: PaneClassification = {
  status: "idle",
  dangerous: false,
  question: false,
  unresolvedFailure: false,
  piLike: true,
  fingerprint: "clean",
  excerpt: "Done",
};

const managed = (overrides: Partial<SessionLifecycleInput> = {}): SessionLifecycleInput => ({
  name: "worker",
  attached: false,
  managed: true,
  owner: "owner-1",
  settledSignal: `${now - 31 * 60_000}:leaf`,
  classification: clean,
  ...overrides,
});

assert.equal(settledAtFromSignal("123456:leaf"), 123456);
assert.equal(settledAtFromSignal("invalid"), undefined);
assert.equal(explicitCloseBlockReason(managed(), "owner-1", "supervisor"), undefined);
assert.match(explicitCloseBlockReason(managed({ attached: true }), "owner-1") ?? "", /attached/);
assert.match(explicitCloseBlockReason(managed({ owner: "other" }), "owner-1") ?? "", /different/);
assert.match(
  explicitCloseBlockReason(managed({ classification: { ...clean, unresolvedFailure: true } }), "owner-1") ?? "",
  /failure/,
);
assert.match(
  explicitCloseBlockReason(managed({ classification: { ...clean, status: "dialog" } }), "owner-1") ?? "",
  /dialog/,
);
assert.equal(automaticCloseBlockReason(managed(), "owner-1", now, 30 * 60_000), undefined);
assert.match(
  automaticCloseBlockReason(managed({ settledSignal: `${now - 29 * 60_000}:leaf` }), "owner-1", now, 30 * 60_000) ?? "",
  /grace period/,
);
assert.match(
  automaticCloseBlockReason(managed({ classification: { ...clean, question: true } }), "owner-1", now, 30 * 60_000) ?? "",
  /question/,
);

const legacy = managed({ managed: false, owner: undefined });
assert.equal(legacyCleanupBlockReason(legacy, now, 10 * 60_000, "supervisor"), undefined);
assert.match(legacyCleanupBlockReason({ ...legacy, attached: true }, now, 10 * 60_000) ?? "", /attached/);
assert.match(
  legacyCleanupBlockReason({ ...legacy, classification: { ...clean, piLike: false } }, now, 10 * 60_000) ?? "",
  /does not look like Pi/,
);
assert.match(
  legacyCleanupBlockReason({ ...legacy, classification: { ...clean, unresolvedFailure: true } }, now, 10 * 60_000) ?? "",
  /failure/,
);

console.log("pi-supervisor lifecycle tests passed");
