import { NextRequest, NextResponse } from "next/server";

import { AGENT_PLAN_OPTIONS, getAgentPlan } from "@/lib/agent-plan";
import { SESSION_COOKIE, verifyAndDecodeSessionToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authenticatedRestaurant(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifyAndDecodeSessionToken(token);
  if (!session) return null;
  const restaurant = session.restaurants[0];
  return restaurant ? { session, restaurant } : null;
}

export async function GET(request: NextRequest) {
  const auth = await authenticatedRestaurant(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const activePlan = getAgentPlan(auth.restaurant);
    return NextResponse.json({ active_plan: activePlan, options: AGENT_PLAN_OPTIONS });
  } catch {
    return NextResponse.json({ error: "Restaurant configuration was not found" }, { status: 404 });
  }
}

// Plan changes are deliberately not exposed to restaurant sessions. The
// internal account/billing workflow updates the stored plan after approval.
