import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifyAndDecodeSessionToken } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_ROUTES = [
  /^orders\/recent$/,
  /^handoffs\/recent$/,
  /^cost\/calls$/,
  /^callers$/,
  /^sessions$/,
  /^sessions\/[A-Za-z0-9_-]+\/(?:messages|debug)$/,
  /^menu$/,
  /^menu\/prompt$/,
  /^menu\/items$/,
  /^menu\/items\/\d+$/,
  /^crm\/customers$/,
];

function allowed(path: string): boolean {
  return ALLOWED_ROUTES.some((pattern) => pattern.test(path));
}

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
  method: "GET" | "POST" | "PUT" | "DELETE",
) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await verifyAndDecodeSessionToken(token);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { path: segments } = await context.params;
  const path = segments.join("/");
  if (!allowed(path)) {
    return NextResponse.json({ error: "Unsupported Telephony route" }, { status: 404 });
  }

  const baseUrl = process.env.TELEPHONY_INTERNAL_URL;
  const apiKey = process.env.TELEPHONY_API_KEY;
  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { error: "Telephony integration is not configured" },
      { status: 503 }
    );
  }

  const upstreamUrl = new URL(path, `${baseUrl.replace(/\/$/, "")}/`);
  request.nextUrl.searchParams.forEach((value, key) => {
    upstreamUrl.searchParams.append(key, value);
  });

  try {
    const body = method === "GET" || method === "DELETE"
      ? undefined
      : await request.arrayBuffer();
    const headers: Record<string, string> = { "X-API-Key": apiKey };
    if (body) headers["Content-Type"] = request.headers.get("content-type") || "application/json";
    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body,
      cache: "no-store",
    });
    writeAuditLog({
      timestamp: new Date().toISOString(),
      staff: session.sub,
      method,
      path,
      upstream: "telephony",
      status: upstream.status,
    });
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Telephony is unavailable" }, { status: 502 });
  }
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, context, "GET");
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, context, "POST");
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, context, "PUT");
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, context, "DELETE");
}
