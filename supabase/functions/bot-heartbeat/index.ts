import { createServiceClient } from "../_shared/supabase.ts";
import { buildHeartbeatUpdate } from "./heartbeat.ts";

Deno.serve(async () => {
  try {
    const supabase = createServiceClient();
    const update = buildHeartbeatUpdate();

    const { error } = await supabase
      .from("bot_settings")
      .update(update)
      .eq("id", 1);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }

    return Response.json({ ok: true, last_heartbeat_at: update.last_heartbeat_at });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
});
