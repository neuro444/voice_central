import { NextRequest, NextResponse } from "next/server";

import { authenticatedDashboardRestaurant } from "@/lib/dashboard-restaurant";
import {
  createMenuItem,
  MenuConflictError,
  MenuNotFoundError,
  MenuValidationError,
  renderMenuText,
} from "@/lib/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function menuError(error: unknown) {
  if (error instanceof SyntaxError) {
    return NextResponse.json({ detail: "request body must be valid JSON" }, { status: 400 });
  }
  if (error instanceof MenuValidationError) {
    return NextResponse.json({ detail: error.message }, { status: 400 });
  }
  if (error instanceof MenuConflictError) {
    return NextResponse.json({ detail: error.message }, { status: 409 });
  }
  if (error instanceof MenuNotFoundError) {
    return NextResponse.json({ detail: error.message }, { status: 404 });
  }
  console.error("[shared menu create] request failed", error);
  return NextResponse.json({ detail: "The shared menu is unavailable" }, { status: 500 });
}

export async function POST(request: NextRequest) {
  const auth = await authenticatedDashboardRestaurant(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as { name?: unknown; price?: unknown };
    const item = createMenuItem(
      auth.restaurant,
      { name: body?.name, price: body?.price },
      auth.session.sub,
    );
    return NextResponse.json(
      { item, menu_text: renderMenuText(auth.restaurant) },
      { status: 201 },
    );
  } catch (error) {
    return menuError(error);
  }
}
