import { describe, expect, it } from "vitest";
import { getHeartbeatStatus, getPremiumDecayCollectorStatus, isNseDashboardSessionOpen } from "./heartbeat";

describe("getHeartbeatStatus", () => {
  it("marks heartbeat as STALE when it is older than 90 seconds", () => {
    const now = new Date("2026-05-26T04:00:00.000Z");
    const heartbeatAt = "2026-05-26T03:58:29.000Z";

    const status = getHeartbeatStatus(heartbeatAt, now);

    expect(status.label).toBe("STALE");
    expect(status.isAlive).toBe(false);
    expect(status.message).toBe("91s ago");
  });

  it("marks heartbeat as ALIVE at exactly 90 seconds", () => {
    const now = new Date("2026-05-26T04:00:00.000Z");
    const heartbeatAt = "2026-05-26T03:58:30.000Z";

    const status = getHeartbeatStatus(heartbeatAt, now);

    expect(status.label).toBe("ALIVE");
    expect(status.isAlive).toBe(true);
    expect(status.message).toBe("90s ago");
  });

  it("returns STALE when no heartbeat exists", () => {
    const status = getHeartbeatStatus(null, new Date("2026-05-26T04:00:00.000Z"));

    expect(status.label).toBe("STALE");
    expect(status.isAlive).toBe(false);
    expect(status.message).toBe("never");
    expect(status.secondsAgo).toBeNull();
  });

  it("returns STANDBY after the market closes", () => {
    expect(getHeartbeatStatus("2026-05-26T10:00:00.000Z", new Date("2026-05-26T10:01:00.000Z"))).toEqual({
      isAlive: true,
      label: "STANDBY",
      secondsAgo: null,
      message: "market closed",
    });
  });
});

describe("isNseDashboardSessionOpen", () => {
  it("recognizes market hours, weekends, and configured holidays", () => {
    expect(isNseDashboardSessionOpen(new Date("2026-06-02T03:45:00.000Z"))).toBe(true);
    expect(isNseDashboardSessionOpen(new Date("2026-06-02T10:01:00.000Z"))).toBe(false);
    expect(isNseDashboardSessionOpen(new Date("2026-06-06T04:00:00.000Z"))).toBe(false);
    expect(isNseDashboardSessionOpen(new Date("2026-06-26T04:00:00.000Z"))).toBe(false);
  });
});

describe("getPremiumDecayCollectorStatus", () => {
  const now = new Date("2026-06-02T04:00:00.000Z");

  it("reports ACTIVE for a recent sample", () => {
    expect(getPremiumDecayCollectorStatus("2026-06-02T03:59:30.000Z", null, null, now)).toEqual({
      label: "ACTIVE",
      message: "30s ago",
    });
  });

  it("surfaces the latest collector error", () => {
    expect(getPremiumDecayCollectorStatus(null, "2026-06-02T03:59:30.000Z", "Angel failed", now)).toEqual({
      label: "ERROR",
      message: "Angel failed",
    });
  });

  it("reports STALE when samples stop arriving during market hours", () => {
    expect(getPremiumDecayCollectorStatus("2026-06-02T03:58:29.000Z", null, null, now)).toEqual({
      label: "STALE",
      message: "91s ago",
    });
  });
});
