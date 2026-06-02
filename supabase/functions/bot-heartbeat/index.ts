import {
  getMarketSessionStatus,
  marketClosedResponse,
} from "../_shared/market-hours.ts";
import { createServiceClient } from "../_shared/supabase.ts";
import { buildHeartbeatUpdate } from "./heartbeat.ts";

Deno.serve(async () => {
  const now = new Date();
  if (!getMarketSessionStatus(now).isOpen) {
    return marketClosedResponse(now);
  }

  try {
    const supabase = createServiceClient();
    const update = buildHeartbeatUpdate(now);

    const { error } = await supabase
      .from("bot_settings")
      .update(update)
      .eq("id", 1);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({
      ok: true,
      last_heartbeat_at: update.last_heartbeat_at,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
});
