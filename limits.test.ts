import assert from "node:assert/strict";
import { maxSessionsFromSettings, spawnLimitReason } from "./limits";

// Unlimited unless a positive whole number is set.
assert.equal(maxSessionsFromSettings({}), undefined);
assert.equal(maxSessionsFromSettings({ piSupervisor: {} }), undefined);
assert.equal(maxSessionsFromSettings({ piSupervisor: { maxSessions: 0 } }), undefined);
assert.equal(maxSessionsFromSettings({ piSupervisor: { maxSessions: -2 } }), undefined);
assert.equal(maxSessionsFromSettings({ piSupervisor: { maxSessions: 2.5 } }), undefined);
assert.equal(maxSessionsFromSettings({ piSupervisor: { maxSessions: "4" } }), undefined);
assert.equal(maxSessionsFromSettings({ piSupervisor: { maxSessions: 4 } }), 4);

// Pi merges global then project settings, project winning; a merged object is what arrives here.
const merged = { ...{ piSupervisor: { maxSessions: 4 } }, ...{ piSupervisor: { maxSessions: 2 } } };
assert.equal(maxSessionsFromSettings(merged), 2);

assert.equal(spawnLimitReason(undefined, ["a", "b", "c", "d", "e"]), undefined);
assert.equal(spawnLimitReason(3, ["a", "b"]), undefined);
const full = spawnLimitReason(2, ["pi-a", "pi-b"]) ?? "";
assert.match(full, /limit of 2/);
assert.match(full, /pi-a, pi-b/);
assert.match(full, /maxSessions/);

console.log("pi-supervisor limit tests passed");
