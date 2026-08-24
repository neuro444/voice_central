import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  verifyCredentials,
  createSessionToken,
  sessionCookieOptions,
  isRateLimited,
  recordFailure,
  clearFailures,
} from "@/lib/auth";

export const runtime = "nodejs";

function clientKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : req.headers.get("x-real-ip")) || "unknown";
}

export async function POST(req: NextRequest) {
  const key = clientKey(req);
  if (isRateLimited(key)) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a few minutes and try again." },
      { status: 429 }
    );
  }

  let username = "";
  let password = "";
  try {
    const body = await req.json();
    username = typeof body.username === "string" ? body.username : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (!username || !password) {
    return NextResponse.json(
      { error: "Please enter both username and password." },
      { status: 400 }
    );
  }

  if (!verifyCredentials(username, password)) {
    recordFailure(key);
    return NextResponse.json(
      { error: "Incorrect username or password." },
      { status: 401 }
    );
  }

  const token = await createSessionToken(username);
  if (!token) {
    // Secret is missing/misconfigured. Refuse to issue a session rather than
    // set one that middleware would reject (fail closed, and make it loud).
    return NextResponse.json(
      { error: "Server auth is not configured. Contact the administrator." },
      { status: 500 }
    );
  }

  clearFailures(key);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
