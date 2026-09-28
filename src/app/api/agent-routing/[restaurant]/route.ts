import { NextRequest, NextResponse } from "next/server";

import { getAgentPlan, getVoiceProvider } from "@/lib/agent-plan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurant: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const configuredKey = process.env.VOICE_ROUTER_API_KEY;
  const requestKey = request.headers.get("X-API-Key");
  if (!configuredKey || !requestKey || requestKey !== configuredKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { restaurant } = await context.params;
  try {
    return NextResponse.json({
      restaurant,
      active_plan: getAgentPlan(restaurant),
      voice_provider: getVoiceProvider(restaurant),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "Restaurant configuration was not found" }, { status: 404 });
  }
}
