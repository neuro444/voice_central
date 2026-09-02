/**
 * Dashboard audit logger — records which staff member accessed which route.
 *
 * Writes one JSONL line per proxied dashboard request to AUDIT_LOG_PATH
 * (default: <cwd>/logs/audit.jsonl).  Uses the Node.js fs module directly;
 * this file must only be imported by routes with `export const runtime = "nodejs"`.
 *
 * Failures are non-fatal: a broken log path never crashes a request.
 */
import fs from "fs";
import path from "path";

const AUDIT_LOG_PATH =
  process.env.AUDIT_LOG_PATH ?? path.join(process.cwd(), "logs", "audit.jsonl");

export interface AuditEntry {
  /** ISO-8601 UTC timestamp of the request. */
  timestamp: string;
  /** Username extracted from the session token (token.sub). */
  staff: string;
  /** HTTP method — always "GET" for current proxy routes. */
  method: string;
  /** Proxied path, e.g. "sessions/abc123/messages". */
  path: string;
  /** Which upstream service was called. */
  upstream: "chat_manager" | "telephony";
  /** HTTP status code returned by the upstream service. */
  status: number;
}

export function writeAuditLog(entry: AuditEntry): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Non-fatal — log to stderr but never interrupt the response.
    console.error("[audit] Failed to write audit log:", err);
  }
}
