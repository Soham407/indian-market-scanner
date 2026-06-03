"use client";

import { useEffect, useRef, useState } from "react";
import type { MarqueeRequest } from "@/app/api/marquee/route";

type MarqueeBannerProps = {
  ctx: MarqueeRequest;
};

function isMarketHours(): boolean {
  const nowIst = new Date(Date.now() + 5.5 * 3600 * 1000);
  const totalMin = nowIst.getUTCHours() * 60 + nowIst.getUTCMinutes();
  return totalMin >= 3 * 60 + 45 && totalMin < 10 * 60;
}

export function MarqueeBanner({ ctx }: MarqueeBannerProps) {
  const [messages, setMessages] = useState<string[]>([]);
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
        // keep empty
      } finally {
        setLoaded(true);
      }
    })();
  }, [ctx]);

  if (!isMarketHours() && !loaded) return null;
  if (loaded && messages.length === 0) return null;

  const SEPARATOR = "  ·  ";
  const text = messages.join(SEPARATOR);

  return (
    <div className="flex h-9 items-center overflow-hidden border-y border-amber-200/70 bg-amber-50/60">
      <div
        className="flex shrink-0 whitespace-nowrap"
        style={{ animation: "marquee-scroll 50s linear infinite" }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLDivElement).style.animationPlayState = "paused")}
        onMouseLeave={(e) => ((e.currentTarget as HTMLDivElement).style.animationPlayState = "running")}
      >
        <span className="px-6 text-[11px] font-medium tracking-wide text-amber-800">
          {text}{SEPARATOR}{text}
        </span>
        <span className="px-6 text-[11px] font-medium tracking-wide text-amber-800" aria-hidden>
          {text}{SEPARATOR}{text}
        </span>
      </div>
    </div>
  );
}
