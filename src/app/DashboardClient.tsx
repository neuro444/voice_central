"use client";
import Image from "next/image";
import { useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import ConversationsScreen from "./ConversationsScreen";
import DashboardScreen from "./DashboardScreen";
import { AnalyticsScreen, MenuScreen } from "./ReferenceScreens";
const API = process.env.NEXT_PUBLIC_API_URL!;
const TELEPHONY_API = "/dashboard-api/telephony";
const CHAT_MANAGER_API = "/dashboard-api/chat-manager";
// Print service base URL. Set NEXT_PUBLIC_PRINT_API_URL to switch targets
// (https://cakeworld.neuroheart.ai on the VPS, http://localhost:7860 locally).
// If unset, fall back to same-origin so the button posts to /print/order on
// whatever domain served the dashboard — works without a rebuild.
const PRINT_API = process.env.NEXT_PUBLIC_PRINT_API_URL ?? "";
const WS  = API.replace("http", "ws") + "/api/ws";

declare global {
  interface Window {
    __authFetchPatched?: boolean;
  }
}

interface Conversation {
  id: string;
  phone: string;
  name: string;
  intent: string;
  state: string;
  channel?: string;
  last_message: string;
  last_message_at: string;
}

// Source-channel badge, used across inbox / approvals / kitchen / pipeline.
const CHANNEL_META: Record<string, { label: string; icon: string; cls: string }> = {
  phone:    { label: "Phone",    icon: "📞", cls: "chan-phone" },
  chat:     { label: "Chat",     icon: "💬", cls: "chan-whatsapp" },
  whatsapp: { label: "WhatsApp", icon: "💬", cls: "chan-whatsapp" },
  sms:      { label: "SMS",      icon: "✉️", cls: "chan-sms" },
};
// Which voice stack took a phone call. channel stays "phone" so all phone
// filters/inboxes keep working; this only refines the badge label.
const RUNTIME_LABEL: Record<string, string> = {
  twilio: "Twilio",
  elevenagents: "ElevenAgents",
};
function ChannelBadge({ channel, runtime }: { channel?: string; runtime?: string | null }) {
  const key = (channel || "whatsapp").toLowerCase();
  const m = CHANNEL_META[key] || CHANNEL_META.whatsapp;
  const rt = runtime ? RUNTIME_LABEL[runtime.toLowerCase()] : "";
  const label = key === "phone" && rt ? `${m.label} · ${rt}` : m.label;
  return (
    <span className={`chan-badge ${m.cls}`} title={`Source: ${label}`}>
      <span aria-hidden="true">{m.icon}</span> {label}
    </span>
  );
}

interface Message {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  media_type: string;
  transcription?: string;
  created_at: string;
}

interface Approval {
  approval_id: number;
  quote_id: number;
  lead_id: number;
  customer_phone: string;
  customer_name: string;
  draft_text: string;
  original_estimated_total: number | null;
  estimated_total: number | null;
  discount_percent: number | null;
  custom_final_price: number | null;
  final_total: number | null;
  occasion: string;
  channel?: string;
  guest_count: number | null;
  event_date: string;
  items_json: string;
  created_at: string;
}

interface Lead {
  id: number;
  customer_phone: string;
  customer_name: string;
  status: string;
  occasion: string;
  channel?: string;
  guest_count: number | null;
  event_date: string;
  estimated_total: number | null;
  approval_status: string | null;
  approval_id: number | null;
  invoice_id: number | null;
  invoice_number: string | null;
  invoice_status: "draft" | "sent" | "paid" | null;
  payment_link: string | null;
  payment_status: "pending" | "paid" | null;
  created_at: string;
}

interface KitchenOrder {
  id: string;
  lead_id?: number;
  order_number: string;
  customer_name: string;
  customer_phone: string;
  order_type: "takeaway" | "catering" | string;
  channel?: string;
  voice_runtime?: string | null;
  items: Array<{ name?: string; quantity?: number; qty?: number; price?: number; unit_price?: number; line_total?: number }>;
  pickup_time: string;
  event_date?: string;
  fulfillment_method?: string;
  occasion?: string;
  guest_count?: number;
  estimated_total: number | null;
  subtotal: number | null;   // authoritative pre-tax total stored at order creation
  tax: number | null;        // authoritative tax amount stored at order creation
  approval_id?: number | null;
  approval_status?: "pending" | "approved" | "rejected" | "sent" | null;
  approval_pending?: boolean;
  status: "received" | "preparing" | "ready" | "picked_up";
  created_at: string;
}

interface CrmCustomer {
  id: string;
  name: string;
  phone: string;
  orders: number;
  spend: number;
  last_order: string;
  diet: string;
  address: string;
  history: Array<{
    type: string;
    id: string;
    status: string;
    occasion?: string;
    guest_count?: number;
    event_date?: string;
    pickup_time?: string;
    total?: number;
    created_at: string;
    items?: Array<{ name?: string; qty?: number }>;
  }>;
}

interface StatusResponse {
  status: string;
  evolution_instance: string;
  auto_replies_enabled: boolean;
  restaurant?: {
    name: string;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
  } | null;
}

// Timestamps from the API are naive UTC (no "Z"). Append "Z" so they parse as UTC,
// then display in the restaurant's timezone (US Eastern).
const RESTAURANT_TZ = "America/New_York";
function asUtc(dt: string): Date {
  const s = /[zZ]|[+-]\d{2}:?\d{2}$/.test(dt) ? dt : `${dt.replace(" ", "T")}Z`;
  return new Date(s);
}
function fmt(dt: string) {
  if (!dt) return "";
  return asUtc(dt).toLocaleTimeString("en-US", {
    hour: "2-digit", minute: "2-digit", timeZone: RESTAURANT_TZ,
  });
}

function money(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "—";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function titleCase(value: string | null | undefined) {
  if (!value) return "Not set";
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function Toast({ msg }: { msg: string }) {
  return <div className="toast">{msg}</div>;
}

// Admin dropdown in each screen header. Just the account trigger + logout.
function AccountMenu({
  compact = false,
  onLogout,
}: {
  compact?: boolean;
  onLogout: () => void;
}) {
  return (
    <details className="account-menu">
      <summary
        className={`account-menu-trigger${compact ? " compact" : ""}`}
        aria-label="Open admin controls"
      >
        <span className="account-menu-avatar">O</span>
        {!compact && <span>Admin</span>}
      </summary>
      <div className="account-menu-dropdown">
        <button
          type="button"
          className="btn btn-outline btn-sm account-menu-logout"
          onClick={onLogout}
        >
          Log out
        </button>
      </div>
    </details>
  );
}

function ApprovalCard({
  approval,
  onDone,
}: {
  approval: Approval;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(approval.draft_text);
  const [discountPct, setDiscountPct] = useState(
    approval.discount_percent != null ? String(approval.discount_percent) : ""
  );
  const [customPrice, setCustomPrice] = useState(
    approval.custom_final_price != null ? String(approval.custom_final_price) : ""
  );
  const [loading, setLoading] = useState(false);
  const originalTotal = approval.original_estimated_total ?? approval.estimated_total;
  const discountNumber = discountPct.trim() === "" ? null : Number(discountPct);
  const customNumber = customPrice.trim() === "" ? null : Number(customPrice);
  const isCatering = approval.occasion !== "takeaway";
  const adjustedTotal =
    originalTotal == null
      ? null
      : customNumber != null && !Number.isNaN(customNumber)
        ? customNumber
        : discountNumber != null && !Number.isNaN(discountNumber) && discountNumber > 0
          ? originalTotal * (1 - discountNumber / 100)
          : null;

  async function send() {
    setLoading(true);
    const res = await fetch(`${API}/api/approvals/${approval.approval_id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        edited_text: editing ? draft : null,
        discount_percent: isCatering && customPrice.trim() === "" && discountPct.trim() !== ""
          ? Number(discountPct)
          : null,
        custom_final_price: isCatering && customPrice.trim() !== ""
          ? Number(customPrice)
          : null,
        approved_by: "staff",
      }),
    });
    setLoading(false);
    if (res.ok) onDone();
  }

  async function reject() {
    await fetch(`${API}/api/approvals/${approval.approval_id}/reject`, { method: "POST" });
    onDone();
  }

  return (
    <article className="approval-card">
      <div className="approval-card-header">
        <div className="approval-card-title">
          <span className="approval-type-icon" aria-hidden="true">
            {approval.occasion === "takeaway" ? "T" : "C"}
          </span>
          <div>
            <div className="approval-eyebrow">
              {approval.occasion === "takeaway" ? "Takeaway order" : "Catering quote"}
            </div>
            <h2>{approval.customer_name || approval.customer_phone}</h2>
          </div>
        </div>
        <div className="approval-card-status">
          <ChannelBadge channel={approval.occasion === "takeaway" ? approval.channel : "whatsapp"} />
          <span className="badge pending">Pending approval</span>
          <time>{fmt(approval.created_at)}</time>
        </div>
      </div>
      <div className="approval-card-body">
        <div className="approval-meta-grid">
          <div className="approval-meta-item">
            <span>Phone</span>
            <strong>{approval.customer_phone}</strong>
          </div>
          {approval.occasion && approval.occasion !== "takeaway" && (
            <div className="approval-meta-item">
              <span>Occasion</span>
              <strong>{approval.occasion}</strong>
            </div>
          )}
          {approval.guest_count && (
            <div className="approval-meta-item">
              <span>Guests</span>
              <strong>{approval.guest_count}</strong>
            </div>
          )}
          {approval.event_date && (
            <div className="approval-meta-item">
              <span>Event date</span>
              <strong>{approval.event_date}</strong>
            </div>
          )}
          {originalTotal != null && (
            <div className="approval-meta-item total">
              <span>Estimated total</span>
              <strong>{money(originalTotal)}</strong>
            </div>
          )}
        </div>

        {isCatering && originalTotal != null && (
          <div className="offer-panel">
            <div className="offer-panel-heading">
              <div>
                <strong>Adjust quote</strong>
                <span>Use either a discount or a custom final price.</span>
              </div>
              <span className="offer-original">Original {money(originalTotal)}</span>
            </div>
            <div className="offer-fields">
              <label>
                Discount %
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  value={discountPct}
                  onChange={(e) => {
                    setDiscountPct(e.target.value);
                    if (e.target.value) setCustomPrice("");
                  }}
                  placeholder="10"
                />
              </label>
              <label>
                Custom Price
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={customPrice}
                  onChange={(e) => {
                    setCustomPrice(e.target.value);
                    if (e.target.value) setDiscountPct("");
                  }}
                  placeholder="2295"
                />
              </label>
            </div>
            <div className="adjusted-total">
              {adjustedTotal != null ? (
                customNumber != null && !Number.isNaN(customNumber) ? (
                  <>
                    Custom final price <strong>{money(adjustedTotal)}</strong>
                  </>
                ) : (
                  <>
                    After {discountNumber}% discount <strong>{money(adjustedTotal)}</strong>
                  </>
                )
              ) : (
                <>No adjustment applied</>
              )}
            </div>
          </div>
        )}

        <div className="approval-draft-heading">
          <div>
            <strong>Customer message</strong>
            <span>{editing ? "Editing draft" : "Ready to review"}</span>
          </div>
          <button
            type="button"
            className="approval-edit-button"
            onClick={() => setEditing(!editing)}
          >
            {editing ? "Preview message" : "Edit draft"}
          </button>
        </div>
        {!editing ? (
          <div className="quote-draft">{draft}</div>
        ) : (
          <textarea
            className="editable-draft"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}

        <div className="approval-actions">
          <button className="btn btn-primary" onClick={send} disabled={loading}>
            {loading ? "Sending…" : "Approve & send"}
          </button>
          <button className="btn btn-outline approval-reject-button" onClick={reject}>
            Reject
          </button>
        </div>
      </div>
    </article>
  );
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [tab, setTab] = useState<
    "dashboard" | "whatsapp_inbox" | "phone_inbox" | "approvals" | "pipeline" |
    "kitchen" | "kanban" | "customers" | "menu" | "analytics" | "settings"
  >("dashboard");
  const [toast, setToast] = useState("");
  const [evoStatus, setEvoStatus] = useState("checking…");
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [autoRepliesEnabled, setAutoRepliesEnabled] = useState(true);
  const [restaurant, setRestaurant] = useState<StatusResponse["restaurant"]>(null);
  const [whatsappQr, setWhatsappQr] = useState("");
  const [whatsappQrOpen, setWhatsappQrOpen] = useState(false);
  const [automationSaving, setAutomationSaving] = useState(false);
  const [whatsappSaving, setWhatsappSaving] = useState(false);
  const [mockupsSeeded, setMockupsSeeded] = useState(false);
  const [mockupStatusLoaded, setMockupStatusLoaded] = useState(false);
  const [mockupsBusy, setMockupsBusy] = useState(false);
  const [liveMessages, setLiveMessages] = useState<{ phone: string; body: string }[]>([]);
  const [staffDraft, setStaffDraft] = useState("");
  const [staffSending, setStaffSending] = useState(false);
  const [operationsRefreshKey, setOperationsRefreshKey] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  }

  // Load initial data
interface ChatManagerCaller {
  user_id: string;
  name: string;
  last_active: string;
}

interface ChatManagerSession {
  session_id: string;
  title: string;
  message_count: number;
  updated_at: string;
  running_summary: string | null;
  name: string;
  order_type: string;
}

interface ChatManagerMessage {
  seq: number;
  role: string;
  content: string;
  created_at: string;
}

// One chat_manager session (+ its caller) -> one Conversation. state is
// always "done": phone sessions are historical transcripts, never a live
// thread needing staff takeover (that is a WhatsApp-only/Evolution API
// concept this does not touch -- Enter Chat/End Session correctly never
// show for phone conversations because of this).
function mapSessionToConversation(session: ChatManagerSession, caller: ChatManagerCaller): Conversation {
  return {
    id: session.session_id,
    phone: caller.user_id,
    name: session.name || caller.name || "Unknown",
    intent: "",
    state: "done",
    channel: "phone",
    last_message: session.running_summary || session.title || "",
    last_message_at: session.updated_at,
  };
}

function mapChatManagerMessage(m: ChatManagerMessage): Message {
  return {
    id: String(m.seq),
    direction: m.role === "user" ? "inbound" : "outbound",
    body: m.content,
    media_type: "text",
    created_at: m.created_at,
  };
}

  async function loadConversations() {
    // Phone conversations come from chat_manager's real /callers + /sessions.
    // WhatsApp still points at the old dead endpoint -- a pre-existing gap,
    // not something this pass fixes, so it stays empty rather than faked.
    try {
      const callersRes = await fetch(`${CHAT_MANAGER_API}/callers`);
      if (!callersRes.ok) return;
      const callers: ChatManagerCaller[] = await callersRes.json();
      const sessionLists = await Promise.all(
        callers.map((caller) =>
          fetch(`${CHAT_MANAGER_API}/sessions?user_id=${encodeURIComponent(caller.user_id)}`)
            .then((r) => (r.ok ? r.json() : []))
            .then((sessions: ChatManagerSession[]) =>
              sessions.map((s) => mapSessionToConversation(s, caller))
            )
            .catch(() => [])
        )
      );
      const data = sessionLists.flat();
      setConversations(data);
      setSelectedConv((current) =>
        current ? data.find((c: Conversation) => c.id === current.id) || current : current
      );
    } catch { /* retain last successful data during outages */ }
  }
  async function loadApprovals() {
    try {
      const r = await fetch(`${API}/api/approvals`);
      if (r.ok) setApprovals(await r.json());
    } catch { /* retain last successful data during outages */ }
  }
  async function loadMessages(convId: string, phone: string) {
    try {
      const r = await fetch(
        `${CHAT_MANAGER_API}/sessions/${convId}/messages?user_id=${encodeURIComponent(phone)}`
      );
      if (r.ok) {
        const raw: ChatManagerMessage[] = await r.json();
        setMessages(raw.map(mapChatManagerMessage));
      }
    } catch { /* retain last successful data during outages */ }
  }
  async function loadStatus() {
    try {
      const r = await fetch(`${API}/api/status`);
      if (r.ok) {
        const d: StatusResponse = await r.json();
        setEvoStatus(d.evolution_instance || "unknown");
        setAutoRepliesEnabled(d.auto_replies_enabled !== false);
        setRestaurant(d.restaurant || null);
        setStatusLoaded(true);
      }
    } catch {
      setEvoStatus("unreachable");
      setStatusLoaded(false);
    }
  }

  async function toggleAutomation() {
    const next = !autoRepliesEnabled;
    setAutomationSaving(true);
    try {
      const res = await fetch(`${API}/api/automation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto_replies_enabled: next }),
      });
      if (!res.ok) throw new Error("automation update failed");
      const data = await res.json();
      const enabled = data.auto_replies_enabled !== false;
      setAutoRepliesEnabled(enabled);
      showToast(enabled ? "Auto-replies resumed" : "Auto-replies paused");
    } catch {
      showToast("Could not update auto-replies");
    } finally {
      setAutomationSaving(false);
    }
  }

  const whatsappConnected = evoStatus === "open";

  async function toggleWhatsapp() {
    const action = whatsappConnected ? "disconnect" : "connect";
    setWhatsappSaving(true);
    try {
      const res = await fetch(`${API}/api/whatsapp/${action}`, { method: "POST" });
      if (!res.ok) {
        showToast("Could not reach WhatsApp / Evolution API");
        return;
      }
      const data = await res.json();
      if (action === "connect") {
        const result = data?.result || {};
        const qr = result.base64 || result.qrcode?.base64 || result.qrcode || result.code || "";
        if (typeof qr === "string" && qr.trim()) {
          setWhatsappQr(qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`);
        } else {
          setWhatsappQr("");
        }
        setWhatsappQrOpen(true);
      }
      showToast(action === "disconnect" ? "WhatsApp disconnected" : "WhatsApp reconnecting…");
      await loadStatus();
    } catch {
      showToast("Could not reach WhatsApp / Evolution API");
    } finally {
      setWhatsappSaving(false);
    }
  }

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      /* ignore — redirect regardless so the session can't linger */
    }
    window.location.href = "/login";
  }

  async function loadMockupStatus() {
    try {
      const r = await fetch(`${API}/api/mockups/status`);
      if (r.ok) {
        const d = await r.json();
        setMockupsSeeded(!!d.seeded);
        setMockupStatusLoaded(true);
      }
    } catch {
      setMockupStatusLoaded(false);
      /* ignore */
    }
  }

  function refreshAllTabs() {
    loadConversations();
    loadApprovals();
    loadStatus();
    loadMockupStatus();
    setOperationsRefreshKey((k) => k + 1);
  }

  async function seedMockups() {
    setMockupsBusy(true);
    try {
      const res = await fetch(`${API}/api/mockups/seed`, { method: "POST" });
      if (!res.ok) {
        showToast("Could not seed demo data");
        return;
      }
      showToast("Demo data loaded — 10 customers across every stage");
      refreshAllTabs();
    } finally {
      setMockupsBusy(false);
    }
  }

  async function clearMockups() {
    setMockupsBusy(true);
    try {
      const res = await fetch(`${API}/api/mockups`, { method: "DELETE" });
      if (!res.ok) {
        showToast("Could not clear demo data");
        return;
      }
      setSelectedConv(null);
      showToast("Demo data cleared — real orders untouched");
      refreshAllTabs();
    } finally {
      setMockupsBusy(false);
    }
  }

  async function enterChat(conv: Conversation) {
    const res = await fetch(`${API}/api/conversations/${conv.id}/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ staff_name: "the catering manager" }),
    });
    if (res.ok) {
      const updated = { ...conv, state: "live_agent" };
      setSelectedConv(updated);
      showToast("Live chat started");
      await loadMessages(conv.id, conv.phone);
      await loadConversations();
    }
  }

  async function sendStaffMessage() {
    if (!selectedConv || !staffDraft.trim()) return;
    setStaffSending(true);
    const res = await fetch(`${API}/api/conversations/${selectedConv.id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: staffDraft.trim() }),
    });
    setStaffSending(false);
    if (res.ok) {
      setStaffDraft("");
      await loadMessages(selectedConv.id, selectedConv.phone);
      await loadConversations();
    }
  }

  async function endSession() {
    if (!selectedConv) return;
    setStaffSending(true);
    const res = await fetch(`${API}/api/conversations/${selectedConv.id}/end`, {
      method: "POST",
    });
    setStaffSending(false);
    if (res.ok) {
      setSelectedConv({ ...selectedConv, state: "done" });
      showToast("Session ended");
      await loadMessages(selectedConv.id, selectedConv.phone);
      await loadConversations();
    }
  }

  // A revoked/expired session only actually surfaces the next time a request
  // hits the server (see auth.ts) -- but this app has ~20 scattered fetch()
  // calls with no shared wrapper, and none of them check for 401 themselves.
  // Without this, a removed user's dashboard just silently stops updating
  // instead of clearly redirecting to /login. Patching window.fetch once,
  // globally, catches every one of those call sites without having to touch
  // each individually. Scoped to this app's own routes only (relative paths,
  // or /dashboard-api/*, /api/*) -- NEXT_PUBLIC_API_URL points at a separate
  // external service (the Cake World backend) whose own 401s, if any, have
  // nothing to do with this dashboard's session and must not trigger this.
  useEffect(() => {
    if (window.__authFetchPatched) return;
    window.__authFetchPatched = true;
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (response.status === 401) {
        const input = args[0];
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const isOwnRoute = url.startsWith("/") || url.startsWith(window.location.origin);
        if (isOwnRoute) {
          window.location.href = "/login";
        }
      }
      return response;
    };
  }, []);

  useEffect(() => {
    loadConversations();
    loadApprovals();
    loadStatus();
    loadMockupStatus();
    const interval = setInterval(() => {
      loadConversations();
      loadApprovals();
      loadStatus();
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (selectedConv) loadMessages(selectedConv.id, selectedConv.phone);
  }, [selectedConv]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [tab]);

  // WebSocket live feed
  useEffect(() => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(WS);
    } catch {
      return;
    }
    wsRef.current = ws;
    ws.onmessage = (e) => {
      let payload;
      try { payload = JSON.parse(e.data); } catch { return; }
      if (payload.type === "inbound_message" || payload.type === "outbound_message") {
        setLiveMessages((prev) => [...prev.slice(-4), payload]);
        loadConversations();
        loadApprovals();
        if (selectedConv) loadMessages(selectedConv.id, selectedConv.phone);
      }
      if (
        payload.type === "kitchen_order_status_updated" ||
        payload.type === "lead_status_updated" ||
        payload.type === "invoice_updated" ||
        payload.type === "order_approved"
      ) {
        setOperationsRefreshKey((value) => value + 1);
      }
      if (payload.type === "approval_created") {
        loadApprovals();
        setOperationsRefreshKey((value) => value + 1);
      }
      if (payload.type === "order_approved") {
        loadApprovals();
      }
      if (payload.type === "automation_updated") {
        setAutoRepliesEnabled(payload.auto_replies_enabled !== false);
      }
      if (payload.type === "mockups_updated") {
        loadConversations();
        loadApprovals();
        loadMockupStatus();
        setOperationsRefreshKey((value) => value + 1);
      }
      if (payload.type === "whatsapp_toggled") {
        loadStatus();
      }
    };
    return () => ws.close();
  }, [selectedConv]);

  const accountMenuProps = {
    onLogout: logout,
  };

  return (
    <div className="app">
      {/* Sidebar */}
      <aside className="sidebar dashboard-sidebar">
        <button type="button" className="cake-world-logo" onClick={() => setTab("dashboard")}>
          <Image
            className="cake-world-logo-image"
            src="/cake-world-logo.jpg"
            alt="Cake World Eatery"
            width={512}
            height={260}
            sizes="(max-width: 760px) 138px, 184px"
          />
        </button>
        <nav className="sidebar-nav primary-sidebar-nav">
          <a
            href="#dashboard"
            className={tab === "dashboard" ? "active" : ""}
            onClick={(e) => { e.preventDefault(); setTab("dashboard"); }}
          >
            <span className="sidebar-icon" aria-hidden="true">▦</span><span className="sidebar-link-label">Dashboard</span>
          </a>
          <a
            href="#orders"
            className={tab === "kitchen" ? "active" : ""}
            onClick={(e) => { e.preventDefault(); setTab("kitchen"); }}
          >
            <span className="sidebar-icon" aria-hidden="true">▤</span><span className="sidebar-link-label">Orders</span>
          </a>
          <a
            href="#crm"
            className={tab === "customers" ? "active" : ""}
            onClick={(e) => { e.preventDefault(); setTab("customers"); }}
          >
            <span className="sidebar-icon" aria-hidden="true">♙</span><span className="sidebar-link-label">CRM</span>
          </a>
          <a
            href="#calls"
            className={tab === "whatsapp_inbox" || tab === "phone_inbox" ? "active" : ""}
            onClick={(e) => { e.preventDefault(); setTab("whatsapp_inbox"); }}
          >
            <span className="sidebar-icon" aria-hidden="true">◌</span><span className="sidebar-link-label">Calls &amp; Messages</span>
          </a>
          <a
            href="#menu"
            className={tab === "menu" ? "active" : ""}
            onClick={(e) => { e.preventDefault(); setTab("menu"); }}
          >
            <span className="sidebar-icon" aria-hidden="true">≡</span><span className="sidebar-link-label">Menu</span>
          </a>
          <a
            href="#analytics"
            className={tab === "analytics" ? "active" : ""}
            onClick={(e) => { e.preventDefault(); setTab("analytics"); }}
          >
            <span className="sidebar-icon" aria-hidden="true">⌁</span><span className="sidebar-link-label">Analytics</span>
          </a>
          <a
            href="#settings"
            className={tab === "settings" ? "active" : ""}
            onClick={(e) => { e.preventDefault(); setTab("settings"); }}
          >
            <span className="sidebar-icon" aria-hidden="true">⚙</span><span className="sidebar-link-label">Settings</span>
          </a>

        </nav>
        <div className="sidebar-profile">
          <span className="account-menu-avatar">A</span>
          <div><strong>Administrator</strong><small>{restaurant?.name || "Restaurant account"}</small></div>
          <button
            type="button"
            className="sidebar-profile-logout"
            onClick={() => void logout()}
            aria-label="Log out"
            title="Log out"
          >
            ↪
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="main">
        {tab !== "dashboard" &&
          tab !== "kitchen" &&
          tab !== "whatsapp_inbox" &&
          tab !== "phone_inbox" && (
          <div className={`topbar${tab === "customers" ? "" : " feature-topbar"}${tab === "menu" ? " menu-topbar" : ""}`}>
            {tab === "customers" ? (
              <div><h1>CRM</h1><p>Every guest who&apos;s called, ordered, or messaged — in one place.</p></div>
            ) : (
              <div>
              <h1>
                {tab === "approvals" && "Approvals"}
                {tab === "pipeline" && "Leads"}
                {tab === "kanban" && "Manager Pipeline"}
                {tab === "menu" && "Menu"}
                {tab === "analytics" && "Analytics"}
                {tab === "settings" && "Settings"}
              </h1>
              <p>
                {tab === "approvals" && "Review and send pending customer quotes."}
                {tab === "pipeline" && "Track every catering opportunity from quote to payment."}
                {tab === "kanban" && "Move catering work through each stage of delivery."}
                {tab === "menu" && "What the AI assistant knows and quotes — powered by the live menu."}
                {tab === "analytics" && "Track your restaurant's performance and AI assistant efficiency."}
                {tab === "settings" && "View the restaurant profile used by the dashboard."}
              </p>
              </div>
            )}
            <div className="reference-header-actions">
              <span className="assistant-online"><i /> Assistant Online</span>
              <span className="reference-header-icon" aria-hidden="true">♧</span>
              <span className="reference-header-icon" aria-hidden="true">?</span>
              <AccountMenu {...accountMenuProps} compact />
            </div>
          </div>
        )}

        {/* ── DASHBOARD (LIVE ACTIVITY) ─────────────────────────────── */}
        {tab === "dashboard" && (
          <DashboardScreen
            api={API}
            telephonyApi={TELEPHONY_API}
            chatManagerApi={CHAT_MANAGER_API}
            refreshKey={operationsRefreshKey}
            accountMenu={<AccountMenu {...accountMenuProps} />}
            onOpenApprovals={() => setTab("approvals")}
            restaurantName={restaurant?.name || "Restaurant"}
            conversations={conversations}
            onOpenConversations={() => setTab("whatsapp_inbox")}
          />
        )}

        {/* ── APPROVALS TAB ─────────────────────────────────────────── */}
        {tab === "approvals" && (
          <div className="content feature-content approvals-content">
            <div className="feature-summary-row approvals-summary">
              <div>
                <span>Waiting for review</span>
                <strong>{approvals.length}</strong>
              </div>
              <p>Pricing and customer messages remain editable until approved.</p>
            </div>
            {approvals.length === 0 ? (
              <div className="feature-empty">
                <span aria-hidden="true">✓</span>
                <strong>You&apos;re all caught up</strong>
                <p>No quotes are waiting for approval.</p>
              </div>
            ) : (
              approvals.map((a) => (
                <ApprovalCard
                  key={a.approval_id}
                  approval={a}
                  onDone={() => {
                    showToast("Sent ✅");
                    loadApprovals();
                  }}
                />
              ))
            )}
          </div>
        )}

        {/* ── CALLS & MESSAGES (WhatsApp / Phone) ───────────────────── */}
        {(tab === "whatsapp_inbox" || tab === "phone_inbox") && (
          <ConversationsScreen
            activeChannel={tab === "phone_inbox" ? "phone" : "whatsapp"}
            conversations={conversations}
            messages={messages}
            selectedConversation={selectedConv}
            staffDraft={staffDraft}
            staffSending={staffSending}
            accountMenu={<AccountMenu {...accountMenuProps} compact />}
            messagesEndRef={messagesEndRef}
            formatTimestamp={fmt}
            onChannelChange={(channel) => {
              setTab(channel === "phone" ? "phone_inbox" : "whatsapp_inbox");
              setSelectedConv((current) => {
                if (!current) return null;
                const currentChannel = (current.channel || "whatsapp").toLowerCase();
                const matches = channel === "phone"
                  ? currentChannel === "phone"
                  : currentChannel !== "phone" && currentChannel !== "sms";
                return matches ? current : null;
              });
            }}
            onSelectConversation={setSelectedConv}
            onEnterChat={enterChat}
            onEndSession={endSession}
            onStaffDraftChange={setStaffDraft}
            onSendStaffMessage={sendStaffMessage}
          />
        )}

        {/* ── PIPELINE TAB ─────────────────────────────────────────── */}
        {tab === "pipeline" && <PipelineTab api={API} refreshKey={operationsRefreshKey} />}
        {tab === "kitchen" && (
          <KitchenTab
            api={API}
            telephonyApi={TELEPHONY_API}
            chatManagerApi={CHAT_MANAGER_API}
            refreshKey={operationsRefreshKey}
            accountMenu={<AccountMenu {...accountMenuProps} compact />}
          />
        )}
        {tab === "kanban" && <ManagerKanbanTab api={API} refreshKey={operationsRefreshKey} />}
        {tab === "customers" && <CustomersTab api={CHAT_MANAGER_API} />}
        {tab === "menu" && <MenuScreen api={CHAT_MANAGER_API} />}
        {tab === "analytics" && <AnalyticsScreen api={API} refreshKey={operationsRefreshKey} />}
        {tab === "settings" && <SettingsTab restaurant={restaurant} />}
      </main>

      {toast && <Toast msg={toast} />}
      {whatsappQrOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setWhatsappQrOpen(false)}>
          <section className="qr-modal" role="dialog" aria-modal="true" aria-labelledby="qr-title" onClick={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setWhatsappQrOpen(false)} aria-label="Close">×</button>
            <h2 id="qr-title">Connect WhatsApp</h2>
            {whatsappQr ? <><img src={whatsappQr} alt="Fresh WhatsApp connection QR code" /><p>Scan this fresh code in WhatsApp to connect the configured Evolution instance.</p></> : (
              <div className="reference-empty compact"><strong>QR code unavailable</strong><span>Evolution accepted the connect request but did not return a QR payload. Check whether the instance is already paired.</span></div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function UnavailableFeatureScreen({
  icon,
  title,
  description,
  items,
}: {
  icon: string;
  title: string;
  description: string;
  items: string[];
}) {
  return (
    <div className="content feature-content unavailable-feature-content">
      <div className="unavailable-feature-card">
        <div className="unavailable-feature-icon" aria-hidden="true">{icon}</div>
        <span className="placeholder-label">UI placeholder</span>
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="unavailable-feature-list">
          {items.map((item) => (
            <div key={item}>
              <span>{item}</span>
              <strong>Unavailable</strong>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SettingsTab({ restaurant }: { restaurant: StatusResponse["restaurant"] }) {
  return (
    <div className="content feature-content settings-content settings-profile-only">
      <section className="settings-profile-card">
        <h2>ⓘ &nbsp; Restaurant Profile</h2>
        {restaurant ? (
          <div className="settings-profile-grid">
            <label>Restaurant Name<strong>{restaurant.name || "—"}</strong></label>
            <label>Phone Number<strong>{restaurant.phone || "—"}</strong></label>
            <label className="wide">Address<strong>{[restaurant.address, restaurant.city, restaurant.state].filter(Boolean).join(", ") || "—"}</strong></label>
          </div>
        ) : <div className="reference-empty compact"><strong>No restaurant profile available</strong><span>The backend did not return restaurant settings.</span></div>}
      </section>
    </div>
  );
}

function PipelineTab({ api, refreshKey }: { api: string; refreshKey: number }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [paymentLinks, setPaymentLinks] = useState<Record<number, string>>({});
  const [sendingLeadId, setSendingLeadId] = useState<number | null>(null);
  const [invoiceLoadingId, setInvoiceLoadingId] = useState<number | null>(null);

  async function loadLeads() {
    fetch(`${api}/api/leads`).then((r) => r.json()).then(setLeads).catch(() => {});
  }

  async function sendPaymentLink(leadId: number) {
    const paymentLink = (paymentLinks[leadId] || "").trim();
    if (!paymentLink) return;

    setSendingLeadId(leadId);
    const res = await fetch(`${api}/api/leads/${leadId}/payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment_link: paymentLink }),
    });
    setSendingLeadId(null);
    if (res.ok) {
      setPaymentLinks((prev) => ({ ...prev, [leadId]: "" }));
      loadLeads();
    }
  }

  async function generateInvoice(leadId: number) {
    setInvoiceLoadingId(leadId);
    const res = await fetch(`${api}/api/leads/${leadId}/invoice`, { method: "POST" });
    setInvoiceLoadingId(null);
    if (res.ok) loadLeads();
  }

  async function sendInvoice(invoiceId: number, leadId: number) {
    setInvoiceLoadingId(leadId);
    const res = await fetch(`${api}/api/invoices/${invoiceId}/send`, { method: "POST" });
    setInvoiceLoadingId(null);
    if (res.ok) loadLeads();
  }

  useEffect(() => {
    loadLeads();
  }, [api, refreshKey]);

  const activeLeads = leads.filter((lead) => !["done", "lost"].includes(normalizeLeadStatus(lead.status))).length;
  const approvedLeads = leads.filter((lead) => lead.approval_status === "sent" || lead.approval_status === "approved").length;
  const paidLeads = leads.filter((lead) => lead.payment_status === "paid").length;

  return (
    <div className="content feature-content leads-content">
      <div className="feature-stat-grid">
        <div className="feature-stat-card">
          <span>Total leads</span>
          <strong>{leads.length}</strong>
          <small>All catering opportunities</small>
        </div>
        <div className="feature-stat-card">
          <span>Active</span>
          <strong>{activeLeads}</strong>
          <small>Still moving through the pipeline</small>
        </div>
        <div className="feature-stat-card">
          <span>Approved</span>
          <strong>{approvedLeads}</strong>
          <small>Customer quotes approved</small>
        </div>
        <div className="feature-stat-card">
          <span>Paid</span>
          <strong>{paidLeads}</strong>
          <small>Payment received</small>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="feature-empty">
          <span aria-hidden="true">◎</span>
          <strong>No leads yet</strong>
          <p>New catering opportunities will appear here automatically.</p>
        </div>
      ) : (
        <div className="lead-card-list">
          {leads.map((lead) => (
            <article className="lead-card" key={lead.id}>
              <div className="lead-card-main">
                <div className="lead-card-heading">
                  <div className="lead-avatar">
                    {(lead.customer_name || lead.customer_phone || "?").slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h2>{lead.customer_name || lead.customer_phone}</h2>
                    <p>{lead.customer_phone}</p>
                  </div>
                </div>
                <div className="lead-status-stack">
                  <ChannelBadge channel={lead.channel} />
                  <span className={`badge ${normalizeLeadStatus(lead.status)}`}>
                    {titleCase(normalizeLeadStatus(lead.status))}
                  </span>
                </div>
              </div>

              <div className="lead-detail-grid">
                <div><span>Occasion</span><strong>{lead.occasion || "Not set"}</strong></div>
                <div><span>Event date</span><strong>{lead.event_date || "Date TBD"}</strong></div>
                <div><span>Guests</span><strong>{lead.guest_count || "TBD"}</strong></div>
                <div><span>Estimated total</span><strong className="money">{money(lead.estimated_total)}</strong></div>
              </div>

              <div className="lead-workflow-row">
                <div className="lead-workflow-status">
                  <span>Approval</span>
                  {lead.approval_status ? (
                    <strong className={`badge ${lead.approval_status}`}>{titleCase(lead.approval_status)}</strong>
                  ) : (
                    <strong className="workflow-placeholder">Not requested</strong>
                  )}
                </div>
                <div className="lead-workflow-status">
                  <span>Invoice</span>
                  {lead.invoice_status ? (
                    <strong className={`badge ${lead.invoice_status}`}>{titleCase(lead.invoice_status)}</strong>
                  ) : (
                    <strong className="workflow-placeholder">Not generated</strong>
                  )}
                  {lead.invoice_number && <small>{lead.invoice_number}</small>}
                </div>
                <div className="lead-workflow-status">
                  <span>Payment</span>
                  {lead.payment_status ? (
                    <strong className={`badge ${lead.payment_status}`}>{titleCase(lead.payment_status)}</strong>
                  ) : (
                    <strong className="workflow-placeholder">Pending</strong>
                  )}
                  {lead.payment_link && (
                    <a className="payment-link" href={lead.payment_link} target="_blank" rel="noreferrer">
                      View link
                    </a>
                  )}
                </div>
              </div>

              <div className="lead-card-actions">
                <div className="invoice-actions">
                  {!lead.invoice_id ? (
                    <button
                      className="btn btn-outline"
                      onClick={() => generateInvoice(lead.id)}
                      disabled={invoiceLoadingId === lead.id}
                    >
                      {invoiceLoadingId === lead.id ? "Generating…" : "Generate invoice"}
                    </button>
                  ) : (
                    <button
                      className="btn btn-outline"
                      onClick={() => sendInvoice(lead.invoice_id!, lead.id)}
                      disabled={invoiceLoadingId === lead.id || lead.invoice_status === "sent" || lead.invoice_status === "paid"}
                    >
                      {invoiceLoadingId === lead.id
                        ? "Sending…"
                        : lead.invoice_status === "sent" || lead.invoice_status === "paid"
                          ? "Invoice sent"
                          : "Send invoice"}
                    </button>
                  )}
                </div>
                <div className="payment-form">
                  <label className="sr-only" htmlFor={`payment-link-${lead.id}`}>Payment link</label>
                  <input
                    id={`payment-link-${lead.id}`}
                    type="url"
                    placeholder="Paste payment link"
                    value={paymentLinks[lead.id] || ""}
                    onChange={(e) =>
                      setPaymentLinks((prev) => ({ ...prev, [lead.id]: e.target.value }))
                    }
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => sendPaymentLink(lead.id)}
                    disabled={sendingLeadId === lead.id || !(paymentLinks[lead.id] || "").trim()}
                  >
                    {sendingLeadId === lead.id ? "Sending…" : "Send payment link"}
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

const kitchenStatuses: KitchenOrder["status"][] = ["received", "preparing", "ready", "picked_up"];
const kitchenLabels: Record<KitchenOrder["status"], string> = {
  received: "Received",
  preparing: "Preparing",
  ready: "Ready",
  picked_up: "Completed",
};

function orderSourceLabel(channel?: string) {
  if (channel === "phone") return "Call";
  if (channel === "whatsapp") return "WhatsApp";
  return "Unknown source";
}

function orderSchedule(order: KitchenOrder) {
  const parts = [order.event_date, order.pickup_time].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return order.fulfillment_method || "TBD";
}

// Derive the Subtotal / Tax breakdown from data already on the order — no server round
// trip. The stored total is tax-inclusive (calculate_order_total: total = subtotal + tax),
// so subtotal is the exact sum of item line totals and tax is the remainder. This keeps
// the printed ticket identical to what the customer was quoted on the call.
function orderMoney(order: KitchenOrder) {
  const items = (order.items || []).map((it) => {
    const quantity = it.quantity ?? it.qty ?? 1;
    const lineTotal =
      it.line_total != null ? it.line_total :
      it.unit_price != null ? quantity * it.unit_price :
      it.price != null ? it.price :
      0;
    const unitPrice =
      it.unit_price != null ? it.unit_price :
      quantity > 0 ? lineTotal / quantity : lineTotal;
    return { name: it.name || "Item", quantity, lineTotal, unitPrice };
  });
  // Use stored subtotal+tax as total when estimated_total is missing/zero —
  // estimated_total can be 0 if the order was created before this field was reliable.
  const storedTotal = order.estimated_total ?? 0;
  const total = storedTotal > 0 ? storedTotal : (order.subtotal ?? 0) + (order.tax ?? 0);
  // Use authoritative subtotal/tax stored from the voice pricing path when available.
  // Fall back to client-side derivation only for legacy orders that predate the columns.
  const subtotal = order.subtotal != null ? order.subtotal : Math.round(items.reduce((s, it) => s + it.lineTotal, 0) * 100) / 100;
  const tax = order.tax != null ? order.tax : Math.max(0, Math.round((total - subtotal) * 100) / 100);
  return { items, subtotal, tax, total };
}

function toPrintPayload(order: KitchenOrder) {
  const { items, subtotal, tax, total } = orderMoney(order);
  return {
    id: String(order.id),
    caller: order.customer_phone || "",
    items: items.map((it) => ({
      name: it.name,
      quantity: it.quantity,
      price: it.lineTotal,
      unit_price: it.unitPrice,
    })),
    subtotal,
    tax,
    total,
    metadata: {
      customer_name: order.customer_name || "",
      pickup_time: order.pickup_time || "",
      takeaway_details: order.order_type === "catering"
        ? [order.occasion, order.event_date, order.guest_count ? `Guests: ${order.guest_count}` : ""].filter(Boolean).join(" · ")
        : "",
    },
  };
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

// Restaurant-style receipt as a browser-printable page (the "PDF" button). Always works
// with no printer; shows the same data as the thermal ticket incl. the Subtotal/Tax/Total
// breakdown. Sized for an 80mm roll but prints fine to PDF from the browser dialog.
function printPdf(order: KitchenOrder) {
  const { items, subtotal, tax, total } = orderMoney(order);
  const money = (n: number) => `$${n.toFixed(2)}`;
  const isCatering = order.order_type === "catering";
  const rows = items
    .map(
      (it) => `<tr>
        <td class="q">${it.quantity}×</td>
        <td>${escapeHtml(it.name)}${it.unitPrice != null ? ` @ ${money(it.unitPrice)}` : ""}</td>
        <td class="amt">${money(it.lineTotal)}</td>
      </tr>`
    )
    .join("");
  const cateringLines = isCatering
    ? `<div class="line"><span>Event</span><span>${escapeHtml(order.occasion || "Catering")}</span></div>
       <div class="line"><span>Date</span><span>${escapeHtml(order.event_date || "TBD")}</span></div>
       <div class="line"><span>Guests</span><span>${escapeHtml(String(order.guest_count ?? "TBD"))}</span></div>`
    : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Order #${order.id}</title>
    <style>
      @page { size: 80mm auto; margin: 0; }
      * { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; }
      body { width: 80mm; margin: 0 auto; padding: 6mm 4mm; font-family: "Courier New", ui-monospace, monospace; color: #000; }
      h1 { font-size: 15px; text-align: center; margin: 0 0 2px; letter-spacing: 1px; }
      .sub { text-align: center; font-size: 11px; margin: 0 0 8px; }
      .rule { border-top: 1px dashed #000; margin: 8px 0; }
      table { width: 100%; border-collapse: collapse; font-size: 13px; }
      td { padding: 2px 0; vertical-align: top; }
      td.q { width: 30px; font-weight: 700; }
      td.amt { width: 64px; text-align: right; white-space: nowrap; }
      .line { display: flex; justify-content: space-between; font-size: 12px; margin: 3px 0; }
      .summary { display: flex; justify-content: space-between; font-size: 12px; margin-top: 4px; }
      .total { display: flex; justify-content: space-between; font-size: 15px; font-weight: 700; margin-top: 6px; }
      .foot { text-align: center; font-size: 11px; margin-top: 10px; }
    </style></head><body>
    <h1>CAKE WORLD</h1>
    <div class="sub">Kitchen Ticket</div>
    <div class="line"><span>Order</span><span>#${order.id}</span></div>
    <div class="line"><span>Customer</span><span>${escapeHtml(order.customer_name || order.customer_phone || "")}</span></div>
    <div class="line"><span>Phone</span><span>${escapeHtml(order.customer_phone || "")}</span></div>
    ${cateringLines}
    <div class="line"><span>${isCatering ? "Service" : "Pickup"}</span><span>${escapeHtml(order.pickup_time || "TBD")}</span></div>
    <div class="rule"></div>
    <table>${rows}</table>
    <div class="rule"></div>
    <div class="summary"><span>Subtotal</span><span>${money(subtotal)}</span></div>
    <div class="summary"><span>Tax</span><span>${money(tax)}</span></div>
    <div class="total"><span>TOTAL</span><span>${money(total)}</span></div>
    <div class="foot">Pay in person at pickup.<br>Thank you!</div>
    </body></html>`;
  const w = window.open("", "_blank", "width=380,height=640");
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}

// Order bell: plays /ringer_ding.mp3 (served from public/, ships with the app — no manual
// asset step). Falls back to a Web Audio "ding" if the mp3 can't load/play. Safe no-op
// if audio is unavailable. NOTE: this dashboard bell is the SECONDARY alert — the print
// server rings the configured ringer file at order arrival (printer/ringer.py), so staff are
// alerted even when the dashboard is closed or down.
let dashboardAudioCtx: AudioContext | null = null;
let dashboardAudioUnlocked = false;
let dashboardRinger: HTMLAudioElement | null = null;

function getDashboardRinger(): HTMLAudioElement | null {
  try {
    if (!dashboardRinger) {
      dashboardRinger = new Audio("/ringer_ding.mp3");
      dashboardRinger.preload = "auto";
      dashboardRinger.volume = 1.0;
    }
    return dashboardRinger;
  } catch {
    return null;
  }
}

function getDashboardAudioContext(): AudioContext | null {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!dashboardAudioCtx) {
      dashboardAudioCtx = new Ctx();
    }
    return dashboardAudioCtx;
  } catch {
    return null;
  }
}

async function unlockDashboardAudio() {
  // Prime the mp3 ringer on a user gesture so later programmatic plays are allowed.
  try {
    const ringer = getDashboardRinger();
    if (ringer) {
      ringer.muted = true;
      await ringer.play();
      ringer.pause();
      ringer.currentTime = 0;
      ringer.muted = false;
    }
  } catch {
    /* mp3 unlock failed — the Web Audio fallback below may still work */
  }
  const ctx = getDashboardAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    dashboardAudioUnlocked = ctx.state === "running";
  } catch {
    dashboardAudioUnlocked = false;
  }
}

function playDing() {
  // Primary: the loud mp3 ring. If it can't play (blocked/missing), fall back to the
  // synthesized ding below.
  try {
    const ringer = getDashboardRinger();
    if (ringer) {
      ringer.currentTime = 0;
      const played = ringer.play();
      if (played) {
        played.then(() => undefined).catch(() => playFallbackDing());
        return;
      }
    }
  } catch {
    /* fall through to the synthesized ding */
  }
  playFallbackDing();
}

function playFallbackDing() {
  try {
    const ctx = getDashboardAudioContext();
    if (!ctx || (!dashboardAudioUnlocked && ctx.state !== "running")) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.42);
    // Do NOT close the shared AudioContext — it's a singleton reused for every ding.
    // Closing it after the first ding silenced all later ones. Just disconnect this
    // oscillator/gain when it finishes so nodes don't accumulate.
    osc.onended = () => {
      try { osc.disconnect(); gain.disconnect(); } catch { /* already gone */ }
    };
  } catch {
    /* audio blocked/unavailable — never break the dashboard */
  }
}

interface TelephonyOrderRecord {
  event: string;
  emitted_at: string;
  call_uuid: string;
  user_id: string;
  session_id: string | null;
  order_type: string;
  name?: string;
  channel?: string;
  order: {
    customer_name?: string;
    fulfillment?: string;
    items?: Array<{ name?: string; quantity?: number; unit_price?: string | number; line_total?: string | number }>;
    subtotal?: string | number;
    tax?: string | number;
    total?: string | number;
    preparation_minutes?: string;
  } | null;
}

// order_type from telephony -> the UI's existing takeaway/catering filter
// buckets. "All" is the default view, so this only affects the two specific
// tabs: pickup/cake/delivery -> takeaway, catering/cake+catering -> catering.
function mapOrderTypeToFilterBucket(orderType: string): "takeaway" | "catering" {
  if (orderType === "catering" || orderType === "cake/catering") return "catering";
  return "takeaway";
}

function toNum(v: string | number | undefined): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

// Mirrors print_client.py's _map_items() exactly (duplicate quantity/qty
// keys, "price" == line_total) so the UI and the print payload stay
// consistent with each other.
function mapTelephonyItems(items: NonNullable<TelephonyOrderRecord["order"]>["items"]) {
  return (items || []).map((item) => {
    const qty = item.quantity ?? 1;
    return {
      name: item.name || "Item",
      quantity: qty,
      qty: qty,
      price: toNum(item.line_total) ?? undefined,
      unit_price: toNum(item.unit_price) ?? undefined,
    };
  });
}

// One telephony order_ready record -> one KitchenOrder.
function mapTelephonyOrderToKitchenOrder(record: TelephonyOrderRecord): KitchenOrder | null {
  if (!record.order) return null;
  const order = record.order;
  return {
    id: record.call_uuid,
    order_number: record.call_uuid.slice(0, 8).toUpperCase(),
    customer_name: order.customer_name || record.name || "Unknown",
    customer_phone: record.user_id || "",
    order_type: mapOrderTypeToFilterBucket(record.order_type),
    channel: record.channel || "phone",
    items: mapTelephonyItems(order.items),
    pickup_time: order.preparation_minutes || "",
    fulfillment_method: order.fulfillment,
    estimated_total: toNum(order.total),
    subtotal: toNum(order.subtotal),
    tax: toNum(order.tax),
    // No lifecycle tracking exists in telephony yet -- every order defaults
    // to "received" until real status tracking is built there.
    status: "received",
    created_at: record.emitted_at,
  };
}

function KitchenTab({
  api,
  telephonyApi,
  chatManagerApi,
  refreshKey,
  accountMenu,
}: {
  api: string;
  telephonyApi: string;
  chatManagerApi: string;
  refreshKey: number;
  accountMenu: ReactNode;
}) {
  const [orders, setOrders] = useState<KitchenOrder[]>([]);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"takeaway" | "catering" | "all">("all");
  const [orderSort, setOrderSort] = useState<"newest" | "oldest" | "customer">("newest");
  const [unprinted, setUnprinted] = useState<Set<string>>(new Set());
  // Order IDs we've already handled (printed or bulk-seen on first load), so a new order
  // is auto-printed exactly once and the existing backlog is never bulk-printed.
  const seenIds = useRef<Set<string> | null>(null);

  async function loadOrders() {
    try {
      const [telephonyResponse, chatResponse] = await Promise.all([
        fetch(`${telephonyApi}/orders/recent`),
        fetch(`${chatManagerApi}/orders/recent`),
      ]);
      const telephonyData: { orders: TelephonyOrderRecord[] } = telephonyResponse.ok
        ? await telephonyResponse.json()
        : { orders: [] };
      const chatData: { orders: TelephonyOrderRecord[] } = chatResponse.ok
        ? await chatResponse.json()
        : { orders: [] };
      if (!telephonyResponse.ok && !chatResponse.ok) return;

      // Phone orders are present in both stores. Prefer telephony's event copy,
      // then add browser/direct-chat orders that have no matching session.
      const phoneSessionIds = new Set(
        telephonyData.orders.map((record) => record.session_id).filter(Boolean)
      );
      const merged = [
        ...telephonyData.orders,
        ...chatData.orders.filter((record) => !phoneSessionIds.has(record.session_id)),
      ].sort((a, b) => b.emitted_at.localeCompare(a.emitted_at));
      const next = merged
        .map(mapTelephonyOrderToKitchenOrder)
        .filter((o): o is KitchenOrder => o !== null);
      setOrders(next);

    // First load: remember everything without printing the backlog.
    if (seenIds.current === null) {
      seenIds.current = new Set(next.map((o) => o.id));
      return;
    }

    // An order appears here only AFTER a manager approves it (backend filters the kitchen
    // list to approved orders). So a newly-appeared order = a just-approved order: ring the
    // bell. We do NOT print here — the voice call already printed the ticket once on hangup.
    const fresh = next.filter((o) => !seenIds.current!.has(o.id));
      for (const order of fresh) {
        seenIds.current!.add(order.id);
        playDing();                       // one ding per newly-approved order
      }
    } catch { /* polling outages must not trigger a Next.js error overlay */ }
  }

  async function updateStatus(orderId: string, _status: KitchenOrder["status"]) {
    // Order-status tracking (received -> preparing -> ready -> picked_up)
    // does not exist in telephony yet -- there is no backend endpoint to
    // call. Surfacing this clearly rather than pretending the click worked.
    window.alert("Status tracking isn't wired up yet on the phone side.");
  }

  async function printTicket(order: KitchenOrder) {
    setPrintingId(order.id);
    try {
      const r = await fetch(`${PRINT_API}/print/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toPrintPayload(order)),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.detail || "print failed");
      }
      // Manual print succeeded — clear any "not printed" flag on this order.
      setUnprinted((prev) => {
        if (!prev.has(order.id)) return prev;
        const next = new Set(prev);
        next.delete(order.id);
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "print failed";
      printPdf(order);
      window.alert(`Printer error: ${message}. The browser print dialog was opened instead.`);
    } finally {
      setPrintingId(null);
    }
  }

  useEffect(() => {
    const unlock = () => { void unlockDashboardAudio(); };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    void unlockDashboardAudio();
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    loadOrders();
    const interval = setInterval(loadOrders, 10000);
    return () => clearInterval(interval);
  }, [api, telephonyApi, chatManagerApi]);

  useEffect(() => {
    loadOrders();
  }, [refreshKey]);

  const visibleOrders = orders
    .filter((order) => filter === "all" || order.order_type === filter)
    .slice()
    .sort((a, b) => {
      if (orderSort === "customer") return (a.customer_name || "").localeCompare(b.customer_name || "");
      const cmp = (a.created_at || "").localeCompare(b.created_at || "");
      return orderSort === "oldest" ? cmp : -cmp;
    });

  return (
    <div className="content orders-content">
      <header className="orders-page-header">
        <div>
          <h2>Orders</h2>
          <p>All orders across channels. Auto-refreshes every 10 seconds.</p>
        </div>
        <div className="orders-header-actions">
          <span className="orders-assistant-online"><i />Assistant Online</span>
          {accountMenu}
        </div>
      </header>
      <div className="orders-filter-row">
        <div className="orders-filter-pills">
          {(["takeaway", "catering", "all"] as const).map((value) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => setFilter(value)}
            >
              {value === "takeaway" ? "Takeaway" : value === "catering" ? "Catering" : "All"}
            </button>
          ))}
        </div>
        <div className="orders-filter-actions">
          <label className="orders-sort">
            <span>Sort</span>
            <select value={orderSort} onChange={(e) => setOrderSort(e.target.value as "newest" | "oldest" | "customer")}>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="customer">Customer A–Z</option>
            </select>
          </label>
          <button className="orders-refresh-button" onClick={loadOrders}><span aria-hidden="true">↻</span>Refresh</button>
        </div>
      </div>
      <div className="orders-list">
        {visibleOrders.map((order) => {
          const activeStage = kitchenStatuses.indexOf(order.status);
          return (
            <article key={order.id} className={`orders-card status-${order.status}`}>
              <div className="orders-card-header">
                <div className="orders-customer-line">
                  <strong className="orders-order-number">#{order.order_number || `ORD-${order.id}`}</strong>
                  <strong>{order.customer_name || order.customer_phone}</strong>
                  <span className={`orders-source-tag ${order.channel || "unknown"}`}>
                    {orderSourceLabel(order.channel)}
                  </span>
                  <span className={`orders-type-tag ${order.order_type}`}>
                    {order.order_type === "catering" ? "Catering" : "Takeaway"}
                  </span>
                  <time>{fmt(order.created_at)}</time>
                </div>
                <div className="orders-status-area">
                  {unprinted.has(order.id) && <span className="orders-unprinted" title="Auto-print failed — click Print or PDF">⚠ Not printed</span>}
                  {order.approval_pending && <span className="orders-approval-pending">Needs Approval</span>}
                  <span className={`orders-status-pill ${order.status}`}>{kitchenLabels[order.status]}</span>
                </div>
              </div>
              <div className="orders-items">
                {order.items.length === 0 ? (
                  <div className="muted-small">No items listed</div>
                ) : (
                  order.items.map((item, idx) => (
                    <div key={idx} className="orders-item">
                      <span>{item.quantity ?? item.qty ?? 1}×</span>
                      <strong>{item.name || "Item"}</strong>
                    </div>
                  ))
                )}
              </div>
              <div className="orders-card-footer">
                <div className="orders-pickup-total">
                  <span>Pickup: {orderSchedule(order)}</span>
                  <strong>{money(order.estimated_total)}</strong>
                </div>
                <div className="orders-card-controls">
                  <div className="orders-stepper" aria-label="Order status">
                    {kitchenStatuses.map((status, index) => (
                      <div className="orders-step-wrap" key={status}>
                        <button
                          className={`orders-step ${index <= activeStage ? "complete" : ""} ${order.status === status ? "current" : ""}`}
                            disabled={updatingId === order.id || order.approval_pending}
                          onClick={() => updateStatus(order.id, status)}
                          title={`Set status to ${kitchenLabels[status]}`}
                        >
                          <span className="orders-step-dot" />
                          <span className="sr-only">{kitchenLabels[status]}</span>
                        </button>
                        {index < kitchenStatuses.length - 1 && <span className={`orders-step-line ${index < activeStage ? "complete" : ""}`} />}
                      </div>
                    ))}
                  </div>
                  <button className="orders-print-button" disabled={printingId === order.id || order.approval_pending} onClick={() => printTicket(order)} title={order.approval_pending ? "Approve the order before kitchen printing" : "Print ticket"} aria-label={`Print ticket for ${order.customer_name || order.customer_phone}`}>🖨</button>
                </div>
              </div>
            </article>
          );
        })}
        {visibleOrders.length === 0 && <div className="empty-panel">No orders yet</div>}
      </div>
    </div>
  );
}

const kanbanColumns = [
  { id: "new", label: "New" },
  { id: "quote_sent", label: "Quote Sent" },
  { id: "negotiating", label: "Negotiating" },
  { id: "confirmed", label: "Confirmed" },
  { id: "preparing", label: "Preparing" },
  { id: "delivery", label: "Delivery" },
  { id: "done", label: "Done" },
];

function normalizeLeadStatus(status: string) {
  if (status === "review") return "new";
  if (status === "sent") return "quote_sent";
  if (status === "won") return "confirmed";
  if (status === "lost") return "done";
  return status || "new";
}

function ManagerKanbanTab({ api, refreshKey }: { api: string; refreshKey: number }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  async function loadLeads() {
    const r = await fetch(`${api}/api/leads`);
    if (r.ok) setLeads(await r.json());
  }

  async function moveLead(leadId: number, status: string) {
    const previous = leads;
    setLeads((items) =>
      items.map((lead) => lead.id === leadId ? { ...lead, status } : lead)
    );
    const r = await fetch(`${api}/api/leads/${leadId}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!r.ok) setLeads(previous);
    else loadLeads();
  }

  useEffect(() => {
    loadLeads();
  }, [api]);

  useEffect(() => {
    loadLeads();
  }, [refreshKey]);

  return (
    <div className="kanban-wrap feature-content">
      <div className="manager-pipeline-summary">
        <div>
          <span>Open pipeline</span>
          <strong>{leads.filter((lead) => normalizeLeadStatus(lead.status) !== "done").length}</strong>
          <small>active leads</small>
        </div>
        <p>Drag a card into another stage to update its live pipeline status.</p>
      </div>
      <div className="kanban-board">
        {kanbanColumns.map((column) => {
          const columnLeads = leads.filter((lead) => normalizeLeadStatus(lead.status) === column.id);
          return (
            <div
              key={column.id}
              className="kanban-column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (draggedId != null) moveLead(draggedId, column.id);
                setDraggedId(null);
              }}
            >
              <div className="kanban-column-head">
                <span><i className={`kanban-stage-dot ${column.id}`} />{column.label}</span>
                <span className="count-pill">{columnLeads.length}</span>
              </div>
              <div className="kanban-list">
                {columnLeads.map((lead) => (
                  <div
                    key={lead.id}
                    className="kanban-card"
                    draggable
                    onDragStart={() => setDraggedId(lead.id)}
                    onDragEnd={() => setDraggedId(null)}
                    onClick={() => setExpandedId(expandedId === lead.id ? null : lead.id)}
                  >
                    <div className="kanban-card-top">
                      <div className="kanban-customer">
                        <span>{(lead.customer_name || lead.customer_phone || "?").slice(0, 1).toUpperCase()}</span>
                        <strong>{lead.customer_name || lead.customer_phone}</strong>
                      </div>
                      <span>{money(lead.estimated_total)}</span>
                    </div>
                    <div className="kanban-occasion">{lead.occasion || "Catering"}</div>
                    <div className="kanban-card-meta">
                      <span>◷ {lead.event_date || "Date TBD"}</span>
                      <span>♙ {lead.guest_count || "?"} guests</span>
                    </div>
                    {expandedId === lead.id && (
                      <div className="kanban-details">
                        <div><span>Phone</span><strong>{lead.customer_phone}</strong></div>
                        <div><span>Approval</span><strong>{titleCase(lead.approval_status)}</strong></div>
                        <div><span>Payment</span><strong>{titleCase(lead.payment_status || "pending")}</strong></div>
                        {lead.payment_link && <div className="truncate">Pay link: {lead.payment_link}</div>}
                      </div>
                    )}
                  </div>
                ))}
                {columnLeads.length === 0 && (
                  <div className="kanban-column-empty">No leads in this stage</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CustomersTab({ api }: { api: string }) {
  const [customers, setCustomers] = useState<CrmCustomer[]>([]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  async function loadCustomers() {
    try {
      const r = await fetch(`${api}/crm/customers`);
      if (r.ok) setCustomers(await r.json());
    } catch { /* retain last successful data during outages */ }
  }

  useEffect(() => {
    loadCustomers();
  }, [api]);

  const filtered = customers
    .filter((customer) => {
      const text = `${customer.name} ${customer.phone} ${customer.diet} ${customer.address}`.toLowerCase();
      return text.includes(query.toLowerCase());
    });
  const selected = filtered.find((customer) => customer.id === selectedId) || filtered[0] || null;

  return (
    <div className="content crm-reference-page">
      <label className="reference-search crm-search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or phone number..." /></label>
      <div className="crm-reference-grid">
        <section className="crm-customer-list">
          <header><h2>All Customers <small>({filtered.length})</small></h2><span>≡</span></header>
          {filtered.length === 0 ? <div className="reference-empty compact"><strong>No customers found</strong></div> : filtered.map((customer) => (
            <button className={selected?.id === customer.id ? "active" : ""} key={customer.id} type="button" onClick={() => setSelectedId(customer.id)}>
              <span className="avatar">{(customer.name || customer.phone || "?").slice(0, 2).toUpperCase()}</span>
              <span><strong>{customer.name || "Unknown customer"}</strong><small>{customer.orders} {customer.orders === 1 ? "order" : "orders"}</small></span>
              <span><em>{customer.orders > 1 ? "REPEAT" : "NEW"}</em><strong>{money(customer.spend)}</strong></span>
            </button>
          ))}
        </section>
        <section className="crm-customer-detail">
          {!selected ? <div className="reference-empty"><strong>No customer data available</strong><span>Customers created through calls and messages will appear here.</span></div> : <>
            <header>
              <span className="crm-detail-avatar">{(selected.name || selected.phone || "?").slice(0, 2).toUpperCase()}</span>
              <div><h2>{selected.name || "Unknown customer"}</h2><p>{selected.phone}</p></div>
              <span className="placeholder-label">Contact actions unavailable</span>
            </header>
            <div className="crm-stat-grid">
              <article><small>Total Orders</small><strong>{selected.orders}</strong></article>
              <article><small>Lifetime Spend</small><strong>{money(selected.spend)}</strong></article>
              <article><small>Avg Order Value</small><strong>{money(selected.orders ? selected.spend / selected.orders : 0)}</strong></article>
            </div>
            <h2 className="crm-history-title">Order History</h2>
            <div className="crm-history-list">
              {selected.history.length === 0 ? <div className="reference-empty compact"><strong>No order history yet</strong></div> : selected.history.map((item) => (
                <article key={`${item.type}-${item.id}`}><span>▤</span><div><strong>#{item.id}</strong><small>{new Date(item.created_at).toLocaleDateString()} · {item.items?.length || 0} items</small></div><strong>{money(item.total)}</strong><em>{titleCase(item.status)}</em></article>
              ))}
            </div>
          </>}
        </section>
      </div>
    </div>
  );
}
