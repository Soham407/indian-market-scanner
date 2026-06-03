import { NextRequest, NextResponse } from "next/server";

export type MarqueeRequest = {
  pcr: number | null;
  pcrClass: "bullish" | "bearish" | "neutral" | null;
  ceMaxOiStrike: number | null;
  peMaxOiStrike: number | null;
  niftyPreviousClose: number | null;
  niftyPreviousOpen: number | null;
};

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

function buildPrompt(ctx: MarqueeRequest): string {
  const parts: string[] = [];

  if (ctx.pcr !== null && ctx.pcrClass !== null) {
    parts.push(`PCR is ${ctx.pcr.toFixed(2)} (${ctx.pcrClass === "bullish" ? "bullish — more puts written, support likely" : ctx.pcrClass === "bearish" ? "bearish — more calls written, resistance likely" : "neutral — balanced positioning"})`);
  }
  if (ctx.ceMaxOiStrike !== null) parts.push(`Highest CE OI at ${ctx.ceMaxOiStrike} (strong resistance)`);
  if (ctx.peMaxOiStrike !== null) parts.push(`Highest PE OI at ${ctx.peMaxOiStrike} (strong support)`);
  if (ctx.niftyPreviousClose !== null && ctx.niftyPreviousOpen !== null) {
    const move = ctx.niftyPreviousClose - ctx.niftyPreviousOpen;
    const movePct = ((move / ctx.niftyPreviousOpen) * 100).toFixed(2);
    parts.push(`Yesterday Nifty moved ${move >= 0 ? "+" : ""}${movePct}% (open ${ctx.niftyPreviousOpen}, close ${ctx.niftyPreviousClose})`);
  }

  return parts.length > 0 ? parts.join(". ") : "NIFTY options chain loaded.";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return NextResponse.json({ messages: ["Market intelligence unavailable — GROQ_API_KEY not configured."] });
  }

  let body: MarqueeRequest;
  try {
    body = await request.json() as MarqueeRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const marketContext = buildPrompt(body);

  try {
    const resp = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqApiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a concise Indian stock market options trading assistant. Given real-time NIFTY options data, generate 4–5 short, actionable trading cautions/insights. Each must be a single sentence under 20 words. Focus on: PCR signals, max pain, premium decay, risk warnings. Respond with ONLY a JSON array of strings, no other text.",
          },
          {
            role: "user",
            content: `Current market data: ${marketContext}. Generate trading insights.`,
          },
        ],
        temperature: 0.4,
        max_tokens: 300,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[marquee] Groq error:", errText);
      return NextResponse.json({ messages: [marketContext] });
    }

    const data = await resp.json() as { choices: Array<{ message: { content: string } }> };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";

    let messages: string[];
    try {
      messages = JSON.parse(raw) as string[];
      if (!Array.isArray(messages)) throw new Error("not array");
    } catch {
      // If Groq doesn't return clean JSON, split on sentence boundaries
      messages = raw.replace(/^\[|\]$/g, "").split(/["\n]+/).map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    }

    return NextResponse.json({ messages: messages.slice(0, 5) });
  } catch (err) {
    console.error("[marquee] fetch error:", err);
    return NextResponse.json({ messages: [marketContext] });
  }
}
