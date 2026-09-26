"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import MetricsRow from "./MetricsRow";

interface DashboardOrder {
  id: string;
  customer_name: string;
  customer_phone: string;
  channel?: string;
  items: Array<{ name?: string; quantity?: number; qty?: number }>;
  estimated_total: number | null;
  subtotal: number | null;
  tax: number | null;
  status: "received" | "preparing" | "ready" | "picked_up";
  approval_pending?: boolean;
  created_at: string;
}

interface CompletedOrderRecord {
  emitted_at: string;
  call_uuid: string;
  user_id: string;
  session_id: string | null;
  name?: string;
  channel?: string;
  approval_pending?: boolean;
  order: {
    customer_name?: string;
    items?: Array<{ name?: string; quantity?: number }>;
    subtotal?: string | number;
    tax?: string | number;
    total?: string | number;
  } | null;
}

// 11agent_repo/dashboard_api.py's _order_record() shape -- keyed by
// conversation_id (no call_uuid/session_id), and items_text is free text
// (no structured per-line items), since ElevenLabs data collection only
// supports scalar field types (see 11agent_repo/docs/ design spec).
interface ElevenLabsOrderRecord {
  emitted_at: string;
  conversation_id: string;
  user_id: string;
  name?: string;
  channel?: string;
  approval_pending?: boolean;
  order: {
    customer_name?: string;
    items_text?: string;
    total?: string | number;
  } | null;
}

function mapElevenLabsOrderToDashboardOrder(record: ElevenLabsOrderRecord): DashboardOrder | null {
  if (!record.order) return null;
  const totalValue = record.order.total;
  const total = totalValue == null || totalValue === ""
    ? null
    : (typeof totalValue === "number" ? totalValue : Number.parseFloat(totalValue));
  return {
    id: record.conversation_id,
    customer_name: record.order.customer_name || record.name || "Unknown",
    customer_phone: record.user_id || "",
    channel: record.channel || "elevenlabs",
    items: record.order.items_text ? [{ name: record.order.items_text, quantity: 1 }] : [],
    estimated_total: Number.isFinite(total) ? total : null,
    subtotal: null,
    tax: null,
    status: "received",
    approval_pending: Boolean(record.approval_pending),
    created_at: record.emitted_at,
  };
}

interface DashboardApproval {
  created_at?: string;
  approval_id: number;
  customer_name: string;
  customer_phone: string;
  items_json: string;
  original_estimated_total: number | null;
  estimated_total: number | null;
  custom_final_price: number | null;
  final_total: number | null;
}
interface DashboardConversation {
  id: string;
  name: string;
  phone: string;
  channel?: string;
  last_message: string;
  last_message_at: string;
  state: string;
}

interface QueueCard {
  created_at?: string;
  id: string;
  customer: string;
  items: string;
  total: number | null;
  onClick?: () => void;
}

function formatDateTime(value: string) {
  if (!value) return "";
  const normalized = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York",
  });
}

function orderTotal(order: DashboardOrder) {
  const estimated = order.estimated_total ?? 0;
  return estimated > 0 ? estimated : (order.subtotal ?? 0) + (order.tax ?? 0);
}

function queueCard(order: DashboardOrder): QueueCard {
  return {
    id: String(order.id),
    created_at: order.created_at,
    customer: order.customer_name || order.customer_phone,
    items: order.items.map((item) => `${item.qty || item.quantity || 1}× ${item.name || "Item"}`).join(", ") || "No items listed",
    total: orderTotal(order),
  };
}

function approvalItemsSummary(itemsJson: string): string {
  try {
    const items: Array<{ name?: string; quantity?: number; qty?: number }> = JSON.parse(itemsJson);
    if (!Array.isArray(items) || items.length === 0) return "No items listed";
    return items
      .map((item) => `${item.qty || item.quantity || 1}× ${item.name || "Item"}`)
      .join(", ");
  } catch {
    return "No items listed";
  }
}

function approvalCard(approval: DashboardApproval, onClick: () => void): QueueCard {
  return {
    id: String(approval.approval_id),
    created_at: approval.created_at,
    customer: approval.customer_name || approval.customer_phone,
    items: approvalItemsSummary(approval.items_json),
    total:
      approval.final_total
      ?? approval.custom_final_price
      ?? approval.estimated_total
      ?? approval.original_estimated_total,
    onClick,
  };
}

function QueueColumn({
  title,
  tone,
  cards,
  emptyNote,
}: {
  title: string;
  tone: string;
  cards: QueueCard[];
  emptyNote?: string;
}) {
  return (
    <div className="dashboard-queue-column">
      <div className="dashboard-queue-heading">
        <span><i className={`queue-dot ${tone}`} />{title}</span>
        <span>{cards.length}</span>
      </div>
      <div className="dashboard-queue-list">
        {cards.length === 0 ? (
          <div className="dashboard-queue-empty">
            <strong>None</strong>
            {emptyNote && <small>{emptyNote}</small>}
          </div>
        ) : (
          cards.map((card) => {
            const content = (
              <>
                <div className="dashboard-order-number"><strong>#{card.id}</strong><span aria-hidden="true">⌁</span></div>
                {card.created_at && <time dateTime={card.created_at}>{formatDateTime(card.created_at)}</time>}
                <h4>{card.customer}</h4>
                <p>{card.items}</p>
                <strong className="dashboard-order-total">
                  {card.total == null ? "—" : `$${card.total.toFixed(2)}`}
                </strong>
              </>
            );
            return card.onClick ? (
              <button
                type="button"
                className={`dashboard-order-card dashboard-order-card-button ${tone}`}
                key={card.id}
                onClick={card.onClick}
                aria-label={`Open pending approval for ${card.customer}`}
              >
                {content}
              </button>
            ) : (
              <article className={`dashboard-order-card ${tone}`} key={card.id}>
                {content}
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}

export default function DashboardScreen({
  api,
  telephonyApi,
  chatManagerApi,
  elevenlabsApi,
  refreshKey,
  accountMenu,
  onOpenApprovals,
  restaurantName,
  conversations,
  onOpenConversations,
}: {
  api: string;
  telephonyApi: string;
  chatManagerApi: string;
  elevenlabsApi: string;
  refreshKey: number;
  accountMenu: ReactNode;
  onOpenApprovals: () => void;
  restaurantName: string;
  conversations: DashboardConversation[];
  onOpenConversations: () => void;
}) {
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [approvals, setApprovals] = useState<DashboardApproval[]>([]);

  useEffect(() => {
    let active = true;
    async function loadDashboardData() {
      try {
        const [telephonyResponse, chatResponse, elevenlabsResponse, approvalsResponse] = await Promise.all([
          fetch(`${telephonyApi}/orders/recent`),
          fetch(`${chatManagerApi}/orders/recent`),
          fetch(`${elevenlabsApi}/orders/recent`),
          fetch(`${api}/api/approvals`),
        ]);
        if (!active) return;
        const telephonyData: { orders: CompletedOrderRecord[] } = telephonyResponse.ok
          ? await telephonyResponse.json()
          : { orders: [] };
        const chatData: { orders: CompletedOrderRecord[] } = chatResponse.ok
          ? await chatResponse.json()
          : { orders: [] };
        const elevenlabsData: { orders: ElevenLabsOrderRecord[] } = elevenlabsResponse.ok
          ? await elevenlabsResponse.json()
          : { orders: [] };
        if (telephonyResponse.ok || chatResponse.ok || elevenlabsResponse.ok) {
          const phoneSessionIds = new Set(
            telephonyData.orders.map((record) => record.session_id).filter(Boolean)
          );
          const merged = [
            ...telephonyData.orders,
            ...chatData.orders.filter((record) => !phoneSessionIds.has(record.session_id)),
          ].sort((a, b) => b.emitted_at.localeCompare(a.emitted_at));
          const numberValue = (value: string | number | undefined) => {
            if (value == null || value === "") return null;
            const parsed = typeof value === "number" ? value : Number.parseFloat(value);
            return Number.isNaN(parsed) ? null : parsed;
          };
          const mappedPhoneAndChat = merged.flatMap((record) => {
            if (!record.order) return [];
            return [{
              id: record.call_uuid,
              customer_name: record.order.customer_name || record.name || "Unknown",
              customer_phone: record.user_id || "",
              channel: record.channel || "phone",
              items: record.order.items || [],
              estimated_total: numberValue(record.order.total),
              subtotal: numberValue(record.order.subtotal),
              tax: numberValue(record.order.tax),
              status: "received" as const,
              approval_pending: Boolean(record.approval_pending),
              created_at: record.emitted_at,
            }];
          });
          // ElevenLabs orders are a distinct call system (own conversation_id,
          // no session_id) -- they never overlap with phone/chat records, so
          // no dedup against phoneSessionIds is needed, just append + re-sort.
          const mappedElevenLabs = elevenlabsData.orders
            .map(mapElevenLabsOrderToDashboardOrder)
            .filter((o): o is DashboardOrder => o !== null);
          setOrders(
            [...mappedPhoneAndChat, ...mappedElevenLabs].sort((a, b) =>
              b.created_at.localeCompare(a.created_at)
            )
          );
        }
        if (approvalsResponse.ok) setApprovals(await approvalsResponse.json());
      } catch {
        // Preserve the last successful view while the backend is temporarily unavailable.
      }
    }
    void loadDashboardData();
    const interval = window.setInterval(loadDashboardData, 10000);
    return () => { active = false; window.clearInterval(interval); };
  }, [api, telephonyApi, chatManagerApi, elevenlabsApi, refreshKey]);

  const needsApproval = approvals.map((approval) => approvalCard(approval, onOpenApprovals));
  const approved = orders.filter((order) => order.status === "received" && !order.approval_pending).map(queueCard);
  const preparing = orders.filter((order) => order.status === "preparing").map(queueCard);
  const ready = orders.filter((order) => order.status === "ready").map(queueCard);

  return (
    <div className="dashboard-screen">
      <header className="dashboard-header">
        <div><h1>Live Activity</h1><p>{restaurantName}</p></div>
        <div className="dashboard-header-actions">
          <span className="assistant-online"><i /> Assistant Online</span>
          {accountMenu}
        </div>
      </header>
      <div className="dashboard-content">
        <MetricsRow orders={orders} variant="dashboard" />
        <section className="activity-panel">
          <div className="dashboard-section-header"><h2>Live Calls &amp; Chats</h2><button type="button" onClick={onOpenConversations}>View all</button></div>
          {conversations.length === 0 ? <div className="dashboard-activity-empty"><strong>No recent activity</strong><small>New calls and messages will appear automatically.</small></div> : (
            <div className="dashboard-activity-list">{conversations.slice(0, 4).map((conversation) => (
              <button type="button" key={conversation.id} onClick={onOpenConversations}>
                <span className="dashboard-activity-avatar">{(conversation.name || conversation.phone || "?").slice(0, 1).toUpperCase()}</span>
                <span><strong>{conversation.name || conversation.phone || "Unknown caller"}</strong><small>{conversation.last_message || "No message content"}</small></span>
                <span><time>{formatDateTime(conversation.last_message_at)}</time><em>{conversation.channel || "Phone"}</em></span>
              </button>
            ))}</div>
          )}
        </section>
        <section className="dashboard-queue">
          <h2>Order Queue</h2>
          <div className="dashboard-queue-grid">
            <QueueColumn title="Needs Approval" tone="approval" cards={needsApproval} />
            <QueueColumn title="Approved" tone="approved" cards={approved} />
            <QueueColumn title="In Kitchen" tone="kitchen" cards={preparing} />
            <QueueColumn title="Ready for Pickup" tone="ready" cards={ready} />
          </div>
        </section>
      </div>
    </div>
  );
}
