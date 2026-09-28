import { getDb } from "./db";

export type AgentPlan = "essential" | "premier";
export type VoiceProvider = "elevenlabs" | "plivo";

export const AGENT_PLAN_OPTIONS: Array<{
  id: AgentPlan;
  name: string;
  description: string;
}> = [
  {
    id: "essential",
    name: "Essential Agent",
    description: "Fast multilingual ordering with menu recognition and pickup order handling.",
  },
  {
    id: "premier",
    name: "Premier Agent",
    description: "Advanced call handling with expanded workflow controls and routing options.",
  },
];

const PROVIDER_BY_PLAN: Record<AgentPlan, VoiceProvider> = {
  essential: "elevenlabs",
  premier: "plivo",
};

export function isAgentPlan(value: unknown): value is AgentPlan {
  return value === "essential" || value === "premier";
}

export function getAgentPlan(restaurantSlug: string): AgentPlan {
  const db = getDb();
  const row = db.prepare(
    `SELECT p.active_plan
       FROM restaurants r
       LEFT JOIN restaurant_agent_plans p ON p.restaurant_id = r.id
      WHERE r.slug = ?`
  ).get(restaurantSlug) as { active_plan: string | null } | undefined;

  if (!row) throw new Error(`Unknown restaurant: ${restaurantSlug}`);
  return isAgentPlan(row.active_plan) ? row.active_plan : "essential";
}

export function setAgentPlan(
  restaurantSlug: string,
  activePlan: AgentPlan,
  updatedBy: string,
): void {
  const db = getDb();
  const restaurant = db.prepare("SELECT id FROM restaurants WHERE slug = ?")
    .get(restaurantSlug) as { id: number } | undefined;
  if (!restaurant) throw new Error(`Unknown restaurant: ${restaurantSlug}`);

  db.prepare(`
    INSERT INTO restaurant_agent_plans (restaurant_id, active_plan, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(restaurant_id) DO UPDATE SET
      active_plan = excluded.active_plan,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(restaurant.id, activePlan, updatedBy);
}

// Server-side integrations can use this without exposing vendor names to the
// restaurant dashboard.
export function getVoiceProvider(restaurantSlug: string): VoiceProvider {
  return PROVIDER_BY_PLAN[getAgentPlan(restaurantSlug)];
}
