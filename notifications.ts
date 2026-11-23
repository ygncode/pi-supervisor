import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep automated events out of the visible user-message queue. */
export function notifySupervisor(pi: Pick<ExtensionAPI, "sendMessage">, content: string): void {
  // Steering is consumed at the next turn, not after an arbitrarily long run.
  // triggerTurn also wakes an idle parent; display:false keeps the transcript
  // compact. The status widget and capture tool remain the human-facing views.
  pi.sendMessage(
    { customType: "pi-supervisor-event", content, display: false },
    { deliverAs: "steer", triggerTurn: true },
  );
}
