"use client";

interface KitchenOrderLike {
  estimated_total: number | null;
  subtotal: number | null;
  tax: number | null;
  status: string;
  created_at: string;
  channel?: string;
}

/**
 * Returns the authoritative total for an order.
 * Mirrors the backend rule: prefer estimated_total, but fall back to
 * subtotal + tax when estimated_total is missing or zero.
 */
function orderTotal(o: KitchenOrderLike): number {
  const est = o.estimated_total ?? 0;
  if (est > 0) return est;
  return (o.subtotal ?? 0) + (o.tax ?? 0);
}

function isToday(iso: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function MetricCard({
  label,
  value,
  sub,
  pending = false,
  positive = false,
}: {
  label: string;
  value: string;
  sub?: string;
  pending?: boolean;
  positive?: boolean;
}) {
  return (
    <div className="metric-card">
      <p className="metric-label">{label}</p>
      <div className="metric-value-row">
        <span className={`metric-value${pending ? " pending" : ""}`}>
          {value}
        </span>
        {sub && (
          <span className={`metric-sub${positive ? " positive" : ""}`}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

export default function MetricsRow({
  orders,
  variant = "orders",
}: {
  orders: KitchenOrderLike[];
  variant?: "orders" | "dashboard";
}) {
  const todaysOrders = orders.filter((o) => isToday(o.created_at));
  const orderCount = todaysOrders.length;
  const revenue = todaysOrders.reduce((sum, o) => sum + orderTotal(o), 0);

  // Orders still moving through the kitchen today.
  const inProgress = todaysOrders.filter(
    (o) => o.status === "received" || o.status === "preparing"
  ).length;

  return (
    <section className="metrics-row">
      <MetricCard
        label="Today's Orders"
        value={String(orderCount)}
        sub={`${todaysOrders.filter((o) => o.channel === "phone").length} by phone`}
      />
      <MetricCard
        label="Today's Revenue"
        value={`$${revenue.toFixed(2)}`}
        sub="Includes tax"
      />
      <MetricCard
        label={variant === "dashboard" ? "Active Calls / Chats" : "Orders In Progress"}
        value={variant === "dashboard" ? "—" : String(inProgress)}
        sub={variant === "dashboard" ? "Not connected yet" : "Received or preparing"}
        pending={variant === "dashboard"}
      />
      <MetricCard
        label="Missed-Call Recovery"
        value="—"
        sub={variant === "dashboard" ? "Not connected yet" : "Needs call log data"}
        pending
      />
    </section>
  );
}
