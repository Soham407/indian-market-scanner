export type HeartbeatStatus = {
  isAlive: boolean;
  label: "ALIVE" | "STALE";
  secondsAgo: number | null;
  message: string;
};

const STALE_AFTER_SECONDS = 90;

export function getHeartbeatStatus(lastHeartbeatAt: string | null, now = new Date()): HeartbeatStatus {
  if (!lastHeartbeatAt) {
    return {
      isAlive: false,
      label: "STALE",
      secondsAgo: null,
      message: "never",
    };
  }

  const heartbeatTime = new Date(lastHeartbeatAt).getTime();
  const secondsAgo = Math.max(0, Math.floor((now.getTime() - heartbeatTime) / 1000));
  const isAlive = Number.isFinite(heartbeatTime) && secondsAgo <= STALE_AFTER_SECONDS;

  return {
    isAlive,
    label: isAlive ? "ALIVE" : "STALE",
    secondsAgo,
    message: `${secondsAgo}s ago`,
  };
}
