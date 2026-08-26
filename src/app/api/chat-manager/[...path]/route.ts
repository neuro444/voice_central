import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROUTES = [
  /^callers$/,
  /^sessions$/,
  /^sessions\/[A-Za-z0-9_-]+\/(?:messages|debug)$/,
];

function allowed(path: string): boolean {
  return ALLOWED_ROUTES.some((pattern) => pattern.test(path));
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!(await verifySessionToken(token))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path: segments } = await context.params;
  const path = segments.join("/");
  if (!allowed(path)) {
    return NextResponse.json({ error: "Unsupported Chat Manager route" }, { status: 404 });
  }

  const baseUrl = process.env.CHAT_MANAGER_API_URL;
  const apiKey = process.env.CHAT_MANAGER_API_KEY;
  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { error: "Chat Manager integration is not configured" },
      { status: 503 }
    );
  }

  const upstreamUrl = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  request.nextUrl.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.append(key, value);
  });

  try {
    const upstream = await fetch(upstreamUrl, {
      headers: { "X-API-Key": apiKey },
      cache: "no-store",
    });
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Chat Manager is unavailable" }, { status: 502 });
  }
}
