import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { notifySupervisor } from "./notifications";

const deliveries: unknown[] = [];
const api: Pick<ExtensionAPI, "sendMessage"> = {
  sendMessage(message, options) { deliveries.push({ message, options }); },
};
const content = "[Pi Supervisor event]\nSession: test-agent\nSTOP: obtain explicit user approval";
notifySupervisor(api, content);
assert.deepEqual(deliveries, [{
  message: { customType: "pi-supervisor-event", content, display: false },
  options: { deliverAs: "steer", triggerTurn: true },
}]);
// This minimal API deliberately has no sendUserMessage: neither busy nor idle
// delivery may enter the user queue. Pi handles both states for custom messages.
assert.ok(JSON.stringify(deliveries).includes("obtain explicit user approval"));
console.log("Supervisor notification delivery tests passed");
