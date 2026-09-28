import { NextRequest, NextResponse } from "next/server";

import { authenticatedDashboardRestaurant } from "@/lib/dashboard-restaurant";
import {
  listMenuItems,
  MenuNotFoundError,
  renderMenuText,
} from "@/lib/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function menuError(error: unknown) {
  if (error instanceof MenuNotFoundError) {
    return NextResponse.json({ detail: error.message }, { status: 404 });
  }
  console.error("[shared menu] request failed", error);
  return NextResponse.json({ detail: "The shared menu is unavailable" }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const auth = await authenticatedDashboardRestaurant(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return NextResponse.json({
      items: listMenuItems(auth.restaurant),
      menu_text: renderMenuText(auth.restaurant),
    });
  } catch (error) {
    return menuError(error);
  }
}
