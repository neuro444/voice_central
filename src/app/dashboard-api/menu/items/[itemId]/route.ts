import { NextRequest, NextResponse } from "next/server";

import { authenticatedDashboardRestaurant } from "@/lib/dashboard-restaurant";
import {
  deleteMenuItem,
  MenuConflictError,
  MenuNotFoundError,
  MenuValidationError,
  renderMenuText,
  updateMenuItem,
} from "@/lib/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ itemId: string }> };

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
  console.error("[shared menu item] request failed", error);
  return NextResponse.json({ detail: "The shared menu is unavailable" }, { status: 500 });
}

async function itemId(context: RouteContext): Promise<number> {
  const raw = (await context.params).itemId;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MenuValidationError("menu item id must be a positive integer");
  }
  return parsed;
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const auth = await authenticatedDashboardRestaurant(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as { name?: unknown; price?: unknown };
    const item = updateMenuItem(
      auth.restaurant,
      await itemId(context),
      { name: body?.name, price: body?.price },
      auth.session.sub,
    );
    return NextResponse.json({ item, menu_text: renderMenuText(auth.restaurant) });
  } catch (error) {
    return menuError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await authenticatedDashboardRestaurant(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const deleted = deleteMenuItem(auth.restaurant, await itemId(context));
    return NextResponse.json({ deleted, menu_text: renderMenuText(auth.restaurant) });
  } catch (error) {
    return menuError(error);
  }
}
