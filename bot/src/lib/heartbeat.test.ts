import { describe, expect, it } from "vitest";
import { getHeartbeatStatus } from "./heartbeat";

describe("getHeartbeatStatus", () => {
  it("marks heartbeat as STALE when it is older than 90 seconds", () => {
    const now = new Date("2026-05-26T11:30:00.000Z");
    const heartbeatAt = "2026-05-26T11:28:29.000Z";

    const status = getHeartbeatStatus(heartbeatAt, now);

    expect(status.label).toBe("STALE");
    expect(status.isAlive).toBe(false);
    expect(status.message).toBe("91s ago");
  });

  it("marks heartbeat as ALIVE at exactly 90 seconds", () => {
    const now = new Date("2026-05-26T11:30:00.000Z");
    const heartbeatAt = "2026-05-26T11:28:30.000Z";

    const status = getHeartbeatStatus(heartbeatAt, now);

    expect(status.label).toBe("ALIVE");
    expect(status.isAlive).toBe(true);
    expect(status.message).toBe("90s ago");
  });

  it("returns STALE when no heartbeat exists", () => {
    const status = getHeartbeatStatus(null, new Date("2026-05-26T11:30:00.000Z"));

    expect(status.label).toBe("STALE");
    expect(status.isAlive).toBe(false);
    expect(status.message).toBe("never");
    expect(status.secondsAgo).toBeNull();
  });
});
