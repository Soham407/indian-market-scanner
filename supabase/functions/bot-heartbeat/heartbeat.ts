export type HeartbeatUpdate = {
  last_heartbeat_at: string;
  updated_at: string;
};

export function buildHeartbeatUpdate(now = new Date()): HeartbeatUpdate {
  const timestamp = now.toISOString();

  return {
    last_heartbeat_at: timestamp,
    updated_at: timestamp,
  };
}
