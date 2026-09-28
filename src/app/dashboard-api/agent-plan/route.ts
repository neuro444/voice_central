import { NextRequest, NextResponse } from "next/server";

import { AGENT_PLAN_OPTIONS, getAgentPlan } from "@/lib/agent-plan";
import { authenticatedDashboardRestaurant } from "@/lib/dashboard-restaurant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authenticatedDashboardRestaurant(request);
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
