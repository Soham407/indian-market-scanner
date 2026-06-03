"use client";

import { useEffect, useRef, useState } from "react";
import type { MarqueeRequest } from "@/app/api/marquee/route";

type MarqueeBannerProps = {
  ctx: MarqueeRequest;
};

const SEPARATOR = " • ";

function isMarketHours(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const h = nowIst.getUTCHours();
  const m = nowIst.getUTCMinutes();
  const totalMin = h * 60 + m;
  // 09:15–15:30 IST = 03:45–10:00 UTC
  return totalMin >= 3 * 60 + 45 && totalMin < 10 * 60;
}

export function MarqueeBanner({ ctx }: MarqueeBannerProps) {
  const [messages, setMessages] = useState<string[]>(["Loading market intelligence…"]);
  const [loaded, setLoaded] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    void (async () => {
      try {
        const resp = await fetch("/api/marquee", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ctx),
        });
        if (resp.ok) {
          const data = await resp.json() as { messages: string[] };
          if (Array.isArray(data.messages) && data.messages.length > 0) {
            setMessages(data.messages);
          }
        }
      } catch {
        // silently keep placeholder
      } finally {
        setLoaded(true);
      }
    })();
  }, [ctx]);

  if (!isMarketHours() && !loaded) return null;

  const combined = messages.join(SEPARATOR);
  // Duplicate for seamless loop
  const track = `${combined}${SEPARATOR}${combined}`;

  return (
    <div className="overflow-hidden rounded-2xl border border-amber-200/80 bg-amber-50/70 px-0 py-2.5 shadow-sm backdrop-blur">
      <div
        className="flex whitespace-nowrap"
        style={{
          animation: "marquee-scroll 40s linear infinite",
        }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.animationPlayState = "paused")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.animationPlayState = "running")}
      >
        <span className="inline-block px-4 text-sm font-medium text-amber-900">
          {track}
        </span>
        <span className="inline-block px-4 text-sm font-medium text-amber-900" aria-hidden>
          {track}
        </span>
      </div>
      <style>{`
        @keyframes marquee-scroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
      `}</style>
    </div>
  );
}
