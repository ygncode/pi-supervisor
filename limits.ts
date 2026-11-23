/**
 * Optional cap on how many Pi sessions one supervisor spawns.
 *
 * Set `piSupervisor.maxSessions` in `~/.pi/agent/settings.json` (global) or
 * `.pi/settings.json` (this project; overrides global). Unset, 0 or anything
 * other than a positive whole number means unlimited.
 */
export function maxSessionsFromSettings(settings: unknown): number | undefined {
  const value = (settings as { piSupervisor?: { maxSessions?: unknown } } | undefined)?.piSupervisor?.maxSessions;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Why a new spawn is refused, or undefined when it may go ahead. */
export function spawnLimitReason(limit: number | undefined, running: string[]): string | undefined {
  if (limit === undefined || running.length < limit) return undefined;
  return (
    `Pi Supervisor has reached its limit of ${limit} spawned session${limit === 1 ? "" : "s"} ` +
    `(running: ${running.join(", ")}). Close one first, or raise piSupervisor.maxSessions ` +
    "in ~/.pi/agent/settings.json or this project's .pi/settings.json."
  );
}
