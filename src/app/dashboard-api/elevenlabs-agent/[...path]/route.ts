import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, verifyAndDecodeSessionToken } from "@/lib/auth";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 11agent_repo/dashboard_api.py exposes exactly these four routes -- no
// /sessions, /menu, or /crm/customers there (see that file's own docstring).
const ALLOWED_ROUTES = [
  /^orders\/recent$/,
  /^handoffs\/recent$/,
  /^cost\/calls$/,
  /^callers$/,
  /^elevenlabs\/saved$/,
  /^elevenlabs\/conversations\/[A-Za-z0-9_-]{1,200}$/,
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
    return NextResponse.json({ error: "Unsupported ElevenLabs agent route" }, { status: 404 });
  }

  if (path.startsWith("elevenlabs/") && method !== "GET") {
    return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
  }

  const baseUrl = process.env.ELEVENLABS_AGENT_INTERNAL_URL;
  const apiKey = path.startsWith("elevenlabs/")
    ? process.env.ELEVENLABS_CONVERSATIONS_API_KEY
    : process.env.ELEVENLABS_AGENT_API_KEY;
  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { error: "ElevenLabs agent integration is not configured" },
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
      upstream: "elevenlabs-agent",
      status: upstream.status,
    });
    if (upstream.status === 401 || upstream.status === 403) {
      // A same-origin 401 makes the dashboard's global fetch patch redirect
      // to /login, mistaking a BACKEND auth failure (e.g. a stale/misconfigured
      // ELEVENLABS_AGENT_API_KEY) for an expired staff session -- this was the
      // root cause of the "dashboard blinking" login loop (see
      // plivo_agent_repo/dashboard_blinking_stop_plan_worked.md). Never
      // forward the raw upstream status for 401/403; log it here (no
      // credentials) and surface it to the browser as a 502 instead.
      console.error(`[elevenlabs-agent proxy] backend auth failure on ${path}: upstream returned ${upstream.status}`);
      return NextResponse.json(
        { error: "ElevenLabs agent backend authentication failed" },
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
    return NextResponse.json({ error: "ElevenLabs agent is unavailable" }, { status: 502 });
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
