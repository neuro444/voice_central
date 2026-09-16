import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifyAndDecodeSessionToken } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The independent plivo_agent_repo backend -- a separate, additive dashboard
// provider (not a replacement for the telephony or chat-manager proxies).
// Same allowlist as the telephony proxy since it implements the same
// GET /orders/recent, /handoffs/recent, /cost/calls contract, plus Phase E's
// conversation/CRM/menu reads.
const ALLOWED_ROUTES = new Set([
  "orders/recent",
  "handoffs/recent",
  "cost/calls",
  "callers",
  "sessions",
  "menu",
  "crm/customers",
]);
// Path segments only (no trailing wildcard entries) -- /sessions/{id}/messages
// and /sessions/{id}/debug carry a variable session id, so they're matched by
// prefix below instead of being enumerable in ALLOWED_ROUTES.
const ALLOWED_SESSION_SUFFIXES = new Set(["messages", "debug"]);

function isAllowedRoute(path: string, segments: string[]): boolean {
  if (ALLOWED_ROUTES.has(path)) return true;
  if (segments.length === 3 && segments[0] === "sessions" && ALLOWED_SESSION_SUFFIXES.has(segments[2])) {
    return true;
  }
  return false;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifyAndDecodeSessionToken(token);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "X-Dashboard-Session": "invalid" } });
  }

  const { path: segments } = await context.params;
  const path = segments.join("/");
  if (!isAllowedRoute(path, segments)) {
    return NextResponse.json({ error: "Unsupported Plivo Agent route" }, { status: 404 });
  }

  const baseUrl = process.env.PLIVO_AGENT_API_URL;
  const apiKey = process.env.PLIVO_AGENT_API_KEY;
  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { error: "Plivo Agent integration is not configured" },
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
      upstream: "plivo_agent",
      status: upstream.status,
    });
    if (upstream.status === 401 || upstream.status === 403) {
      console.error("Dashboard upstream authentication failed", { path, status: upstream.status });
      return NextResponse.json(
        { error: "Backend authentication failed; contact the administrator" },
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
    return NextResponse.json({ error: "Plivo Agent is unavailable" }, { status: 502 });
  }
}
