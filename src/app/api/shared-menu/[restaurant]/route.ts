import { NextRequest, NextResponse } from "next/server";

import { listMenuItems, MenuNotFoundError, renderMenuText } from "@/lib/menu";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurant: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const configuredKey = process.env.SHARED_MENU_API_KEY;
  if (!configuredKey) {
    return NextResponse.json({ error: "Shared menu integration is not configured" }, { status: 503 });
  }
  if (request.headers.get("x-api-key") !== configuredKey) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { restaurant } = await context.params;
  try {
    return NextResponse.json({
      restaurant,
      items: listMenuItems(restaurant),
      menu_text: renderMenuText(restaurant),
    });
  } catch (error) {
    if (error instanceof MenuNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error("[shared menu integration] request failed", error);
    return NextResponse.json({ error: "The shared menu is unavailable" }, { status: 500 });
  }
}
