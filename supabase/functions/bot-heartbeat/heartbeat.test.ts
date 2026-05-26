import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildHeartbeatUpdate } from "./heartbeat.ts";

Deno.test("buildHeartbeatUpdate: uses the same ISO timestamp for heartbeat and updated_at", () => {
  const fixedTime = new Date("2026-05-26T11:31:00.000Z");

  const update = buildHeartbeatUpdate(fixedTime);

  assertEquals(update.last_heartbeat_at, "2026-05-26T11:31:00.000Z");
  assertEquals(update.updated_at, "2026-05-26T11:31:00.000Z");
});
