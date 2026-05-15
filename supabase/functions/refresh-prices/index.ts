import { createServiceClient } from "../_shared/supabase.ts";
import {
  getMarketSessionStatus,
  marketClosedResponse,
} from "../_shared/market-hours.ts";

type Instrument = {
  id: string;
  last_price: number | null;
};

Deno.serve(async () => {
  if (!getMarketSessionStatus().isOpen) {
    return marketClosedResponse();
  }

  const supabase = createServiceClient();

  const { data: instruments, error } = await supabase
    .from("instruments")
    .select("id,last_price")
    .not("last_price", "is", null);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const priceMarks = (instruments ?? []).map((instrument: Instrument) => ({
    instrument_id: instrument.id,
    price: instrument.last_price,
    source: "edge_function",
  }));

  if (priceMarks.length > 0) {
    const { error: markError } = await supabase.from("price_marks").insert(priceMarks);

    if (markError) {
      return Response.json({ error: markError.message }, { status: 500 });
    }
  }

  for (const instrument of instruments ?? []) {
    await supabase
      .from("shadow_trades")
      .update({ current_price: instrument.last_price })
      .eq("instrument_id", instrument.id)
      .eq("status", "open");
  }

  return Response.json({ refreshed: priceMarks.length });
});
