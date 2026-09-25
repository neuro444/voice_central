import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifyAndDecodeSessionToken } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROUTES = [
  /^callers$/,
  /^sessions$/,
  /^sessions\/[A-Za-z0-9_-]+\/(?:messages|debug)$/,
  /^orders\/recent$/,
  /^menu$/,
  /^crm\/customers$/,
];

function allowed(path: string): boolean {
  return ALLOWED_ROUTES.some((pattern) => pattern.test(path));
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifyAndDecodeSessionToken(token);
  if (!session) {
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
    writeAuditLog({
      timestamp: new Date().toISOString(),
      staff: session.sub,
      method: "GET",
      path,
      upstream: "chat_manager",
      status: upstream.status,
    });
    if (upstream.status === 401 || upstream.status === 403) {
      // A same-origin 401 makes the dashboard's global fetch patch redirect
      // to /login, mistaking a BACKEND auth failure (e.g. a stale/misconfigured
      // CHAT_MANAGER_API_KEY) for an expired staff session -- this was the
      // root cause of the "dashboard blinking" login loop. Never forward the
      // raw upstream status for 401/403; log it here (no credentials) and
      // surface it to the browser as a 502 instead.
      console.error(`[chat-manager proxy] backend auth failure on ${path}: upstream returned ${upstream.status}`);
      return NextResponse.json(
        { error: "Chat Manager backend authentication failed" },
        { status: 502 }
      );
    }
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
