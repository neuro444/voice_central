import { NextRequest, NextResponse } from "next/server";

import { AGENT_PLAN_OPTIONS, getAgentPlan, isAgentPlan, setAgentPlan } from "@/lib/agent-plan";
import { SESSION_COOKIE, verifyAndDecodeSessionToken } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";

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

export async function PUT(request: NextRequest) {
  const auth = await authenticatedRestaurant(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request" }, { status: 400 });
  }
  const activePlan = (body as { active_plan?: unknown } | null)?.active_plan;
  if (!isAgentPlan(activePlan)) {
    return NextResponse.json({ error: "Choose Essential Agent or Premier Agent" }, { status: 422 });
  }

  try {
    setAgentPlan(auth.restaurant, activePlan, auth.session.sub);
    writeAuditLog({
      timestamp: new Date().toISOString(),
      staff: auth.session.sub,
      method: "PUT",
      path: "agent-plan",
      upstream: "voice_central",
      status: 200,
    });
    return NextResponse.json({ active_plan: activePlan, options: AGENT_PLAN_OPTIONS });
  } catch {
    return NextResponse.json({ error: "Agent plan could not be saved" }, { status: 500 });
  }
}
