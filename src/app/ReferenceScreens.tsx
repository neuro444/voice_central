"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type MenuSource = "takeaway" | "catering" | "cakes";
type MenuPriceKey = "S" | "M" | "L" | "price";
type TakeawayMenuItem = {
  id: string;
  category: string;
  name: string;
  price: string | null;
};
type TakeawayMenuSection = {
  name: string;
  label: string;
  items: TakeawayMenuItem[];
};
type CateringMenuItem = {
  id: string;
  category: string;
  number: string;
  name: string;
  prices: Partial<Record<MenuPriceKey, string | null>>;
  supports_sizes: boolean;
};
type CateringMenuSection = { name: string; items: CateringMenuItem[] };
type CakeCombination = {
  id: string;
  weight_lb: number;
  tiers: number;
  price: string | null;
};
type CakeClass = {
  id: "standard" | "speciality";
  name: string;
  flavors: string[];
  combinations: CakeCombination[];
};
type MenuResponse = {
  takeaway: {
    sections: TakeawayMenuSection[];
    category_count: number;
    item_count: number;
  };
  catering: {
    sections: CateringMenuSection[];
    category_count: number;
    item_count: number;
  };
  cakes: {
    classes: CakeClass[];
    class_count: number;
    flavor_count: number;
    price_count: number;
  };
};
type FieldMeta = {
  source: MenuSource;
  itemId: string;
  key: MenuPriceKey;
};
type CakePreview = {
  flavor: string;
  weight: number;
  tiers: number;
  quantity: string;
};

const emptyMenu: MenuResponse = {
  takeaway: { sections: [], category_count: 0, item_count: 0 },
  catering: { sections: [], category_count: 0, item_count: 0 },
  cakes: { classes: [], class_count: 0, flavor_count: 0, price_count: 0 },
};

const menuFieldId = (source: MenuSource, itemId: string, key: MenuPriceKey) =>
  `${source}::${itemId}::${key}`;

type Order = {
  id: number;
  estimated_total: number | null;
  subtotal: number | null;
  tax: number | null;
  channel?: string;
  status: string;
  created_at: string;
  items: Array<{ name?: string; qty?: number; quantity?: number; line_total?: number }>;
};

type Conversation = { id: number; channel?: string; state: string };

const requestJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<T>;
};

const total = (order: Order) =>
  order.estimated_total && order.estimated_total > 0
    ? order.estimated_total
    : (order.subtotal ?? 0) + (order.tax ?? 0);

export function MenuScreen({ api }: { api: string }) {
  const [menu, setMenu] = useState<MenuResponse>(emptyMenu);
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fieldMeta, setFieldMeta] = useState<Record<string, FieldMeta>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [cateringSizes, setCateringSizes] = useState<Record<string, MenuPriceKey>>({});
  const [cakePreviews, setCakePreviews] = useState<Record<string, CakePreview>>({});
  const [activeSource] = useState<MenuSource>("takeaway");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const loadMenu = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await requestJson<MenuResponse>(`${api}/menu`);
      const nextOriginals: Record<string, string> = {};
      const nextMeta: Record<string, FieldMeta> = {};
      const nextQuantities: Record<string, string> = {};
      const nextCateringSizes: Record<string, MenuPriceKey> = {};
      const nextCakePreviews: Record<string, CakePreview> = {};

      data.takeaway.sections.forEach((section) => section.items.forEach((item) => {
        if (item.price != null) {
          const id = menuFieldId("takeaway", item.id, "price");
          nextOriginals[id] = item.price;
          nextMeta[id] = { source: "takeaway", itemId: item.id, key: "price" };
        }
        nextQuantities[`takeaway::${item.id}`] = "1";
      }));
      data.catering.sections.forEach((section) => section.items.forEach((item) => {
        (Object.entries(item.prices) as Array<[MenuPriceKey, string | null]>).forEach(([key, value]) => {
          if (value != null) {
            const id = menuFieldId("catering", item.id, key);
            nextOriginals[id] = value;
            nextMeta[id] = { source: "catering", itemId: item.id, key };
          }
        });
        const firstSize = (["S", "M", "L"] as const).find((size) => item.prices[size] != null);
        if (firstSize) nextCateringSizes[item.id] = firstSize;
        else if (item.prices.price != null) nextCateringSizes[item.id] = "price";
        nextQuantities[`catering::${item.id}`] = "1";
      }));
      data.cakes.classes.forEach((cakeClass) => {
        cakeClass.combinations.forEach((combination) => {
          if (combination.price != null) {
            const id = menuFieldId("cakes", combination.id, "price");
            nextOriginals[id] = combination.price;
            nextMeta[id] = { source: "cakes", itemId: combination.id, key: "price" };
          }
        });
        const first = cakeClass.combinations[0];
        if (first) {
          nextCakePreviews[cakeClass.id] = {
            flavor: cakeClass.flavors[0] || "",
            weight: first.weight_lb,
            tiers: first.tiers,
            quantity: "1",
          };
        }
      });
      setMenu(data);
      setOriginals(nextOriginals);
      setDrafts(nextOriginals);
      setFieldMeta(nextMeta);
      setQuantities(nextQuantities);
      setCateringSizes(nextCateringSizes);
      setCakePreviews(nextCakePreviews);
    } catch {
      setError("The pickup menu could not be loaded from Chat Manager. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void loadMenu(); }, [loadMenu]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleTakeawaySections = useMemo(() => menu.takeaway.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        `${section.label} ${item.name}`.toLowerCase().includes(normalizedQuery)
      ),
    }))
    .filter((section) => section.items.length > 0), [menu.takeaway.sections, normalizedQuery]);
  const visibleCateringSections = useMemo(() => menu.catering.sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        `${section.name} ${item.name}`.toLowerCase().includes(normalizedQuery)
      ),
    }))
    .filter((section) => section.items.length > 0), [menu.catering.sections, normalizedQuery]);
  const visibleCakeClasses = useMemo(() => menu.cakes.classes
    .map((cakeClass) => {
      const classMatches = cakeClass.name.toLowerCase().includes(normalizedQuery);
      return {
        ...cakeClass,
        visibleFlavors: classMatches
          ? cakeClass.flavors
          : cakeClass.flavors.filter((flavor) => flavor.toLowerCase().includes(normalizedQuery)),
      };
    })
    .filter((cakeClass) => cakeClass.visibleFlavors.length > 0 || !normalizedQuery),
  [menu.cakes.classes, normalizedQuery]);

  const changedFields = Object.keys(drafts).filter((key) => drafts[key] !== originals[key]);
  const validatePrice = (value: string) => {
    if (!value.trim()) return "Required";
    if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return "Enter a non-negative number";
    return "";
  };
  const validateQuantity = (value: string) => {
    if (!value.trim()) return "Required";
    if (!/^[1-9]\d*$/.test(value.trim())) return "Use a positive whole number";
    return "";
  };
  const invalidFields = Object.keys(drafts).filter((key) => validatePrice(drafts[key]));
  const invalidQuantities = [
    ...Object.entries(quantities)
      .filter(([, value]) => validateQuantity(value))
      .map(([key]) => key),
    ...Object.entries(cakePreviews)
      .filter(([, preview]) => validateQuantity(preview.quantity))
      .map(([key]) => `cake::${key}`),
  ];

  function discard() {
    setDrafts(originals);
    setError("");
    setSuccess("");
  }

  async function save() {
    if (changedFields.length === 0) return;
    if (invalidFields.length > 0 || invalidQuantities.length > 0) {
      setSuccess("");
      setError("Fix the highlighted prices and quantities before saving.");
      return;
    }
    const updates = new Map<string, {
      source: MenuSource;
      item_id: string;
      prices: Record<string, string>;
    }>();
    changedFields.forEach((fieldId) => {
      const meta = fieldMeta[fieldId];
      if (!meta) return;
      const updateId = `${meta.source}::${meta.itemId}`;
      const existing = updates.get(updateId) || {
        source: meta.source,
        item_id: meta.itemId,
        prices: {},
      };
      existing.prices[meta.key] = drafts[fieldId].trim();
      updates.set(updateId, existing);
    });
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const response = await fetch(`${api}/api/menu/prices`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: Array.from(updates.values()) }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || `Save failed (${response.status})`);
      }
      await loadMenu();
      setSuccess("Menu prices saved, reloaded, and synced to the assistant.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Menu prices could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  function priceEditor(
    source: MenuSource,
    itemId: string,
    itemName: string,
    key: MenuPriceKey,
    label?: string,
  ) {
    const id = menuFieldId(source, itemId, key);
    if (!(id in drafts)) return null;
    const validation = validatePrice(drafts[id]);
    const changed = drafts[id] !== originals[id];
    return (
      <label className={`menu-price-field${changed ? " changed" : ""}${validation ? " invalid" : ""}`} key={key}>
        {label && <span>{label}</span>}
        <input
          type="text"
          inputMode="decimal"
          readOnly
          aria-label={`${itemName} ${label || "price"}`}
          aria-invalid={!!validation}
          value={drafts[id]}
        />
        {changed && <i className="menu-dirty-dot" aria-label="Unsaved change" />}
        {validation && <small className="menu-price-error">{validation}</small>}
      </label>
    );
  }

  function quantityEditor(source: "takeaway" | "catering", itemId: string, itemName: string) {
    const id = `${source}::${itemId}`;
    const value = quantities[id] || "";
    const validation = validateQuantity(value);
    return (
      <label className={`menu-quantity-field${validation ? " invalid" : ""}`}>
        <span>Qty</span>
        <input
          type="text"
          inputMode="numeric"
          aria-label={`${itemName} quantity`}
          aria-invalid={!!validation}
          value={value}
          onChange={(event) => {
            setQuantities((current) => ({ ...current, [id]: event.target.value }));
            setError("");
            setSuccess("");
          }}
        />
        {validation && <small>{validation}</small>}
      </label>
    );
  }

  function previewTotal(price: string | undefined, quantity: string) {
    if (validatePrice(price || "") || validateQuantity(quantity)) return "—";
    const amount = Number(price) * Number(quantity);
    return amount.toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }

  function renderTakeaway() {
    if (!visibleTakeawaySections.length) {
      return <div className="reference-empty"><strong>No Pickup &amp; Takeaway items found</strong></div>;
    }
    return (
      <div className="catering-menu-sections">
        {visibleTakeawaySections.map((section) => (
          <details className="catering-menu-section" key={section.name} open>
            <summary><h2>{section.label}</h2><span>{section.items.length} items</span><i>•••</i></summary>
            <div>
              {section.items.map((item) => {
                const quantity = quantities[`takeaway::${item.id}`] || "";
                const priceId = menuFieldId("takeaway", item.id, "price");
                return (
                  <div className="catering-menu-item menu-item-with-preview" key={item.id}>
                    <span className="menu-drag-handle" aria-hidden="true">⠿</span>
                    <strong className="catering-menu-item-name">{item.name}</strong>
                    <div className="menu-price-fields">
                      {priceEditor("takeaway", item.id, item.name, "price", "Unit price")}
                    </div>
                    <div className="menu-preview-controls">
                      {quantityEditor("takeaway", item.id, item.name)}
                      <span className="menu-item-total"><small>Item total</small><strong>{previewTotal(drafts[priceId], quantity)}</strong></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    );
  }

  function renderCatering() {
    if (!visibleCateringSections.length) {
      return <div className="reference-empty"><strong>No Catering items found</strong></div>;
    }
    return (
      <div className="catering-menu-sections">
        {visibleCateringSections.map((section) => (
          <details className="catering-menu-section" key={section.name} open>
            <summary><h2>{section.name}</h2><span>{section.items.length} items</span><i>•••</i></summary>
            <div>
              {section.items.map((item) => {
                const selected = cateringSizes[item.id];
                const quantity = quantities[`catering::${item.id}`] || "";
                const selectedField = selected
                  ? menuFieldId("catering", item.id, selected)
                  : "";
                const availableSizes = (["S", "M", "L"] as const)
                  .filter((size) => item.prices[size] != null);
                return (
                  <div className="catering-menu-item menu-item-with-preview" key={item.id}>
                    <span className="menu-drag-handle" aria-hidden="true">⠿</span>
                    <strong className="catering-menu-item-name">{item.name}</strong>
                    <div className="menu-price-fields">
                      {item.supports_sizes ? (
                        availableSizes.map((size) =>
                          priceEditor("catering", item.id, item.name, size, size)
                        )
                      ) : item.prices.price != null ? (
                        priceEditor("catering", item.id, item.name, "price", "Price")
                      ) : (
                        <span className="menu-market-price">Manual quote · ask staff</span>
                      )}
                    </div>
                    <div className="menu-preview-controls">
                      {availableSizes.length > 0 && (
                        <label className="menu-select-field">
                          <span>Size</span>
                          <select
                            aria-label={`${item.name} selected size`}
                            value={selected || availableSizes[0]}
                            onChange={(event) => setCateringSizes((current) => ({
                              ...current,
                              [item.id]: event.target.value as MenuPriceKey,
                            }))}
                          >
                            {availableSizes.map((size) => <option key={size}>{size}</option>)}
                          </select>
                        </label>
                      )}
                      {quantityEditor("catering", item.id, item.name)}
                      <span className="menu-item-total">
                        <small>Item total</small>
                        <strong>
                          {selectedField
                            ? previewTotal(drafts[selectedField], quantity)
                            : "Manual quote"}
                        </strong>
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    );
  }

  function renderCakes() {
    if (!visibleCakeClasses.length) {
      return <div className="reference-empty"><strong>No Cake flavors found</strong></div>;
    }
    return (
      <div className="cake-menu-classes">
        {visibleCakeClasses.map((cakeClass) => {
          const preview = cakePreviews[cakeClass.id];
          if (!preview) return null;
          const weights = Array.from(new Set(cakeClass.combinations.map((entry) => entry.weight_lb)));
          const combinationsForWeight = cakeClass.combinations.filter(
            (entry) => entry.weight_lb === preview.weight
          );
          const selectedCombination = combinationsForWeight.find(
            (entry) => entry.tiers === preview.tiers
          ) || combinationsForWeight[0];
          const selectedPriceId = selectedCombination
            ? menuFieldId("cakes", selectedCombination.id, "price")
            : "";
          const quantityError = validateQuantity(preview.quantity);
          return (
            <section className="cake-menu-class-card" key={cakeClass.id}>
              <header>
                <div><h2>{cakeClass.name}</h2><span>{cakeClass.flavors.length} flavors</span></div>
                <div className="cake-flavor-list">
                  {cakeClass.visibleFlavors.map((flavor) => <span key={flavor}>{flavor}</span>)}
                </div>
              </header>
              <div className="cake-preview-panel">
                <label className="menu-select-field">
                  <span>Flavor</span>
                  <select
                    value={preview.flavor}
                    onChange={(event) => setCakePreviews((current) => ({
                      ...current,
                      [cakeClass.id]: { ...preview, flavor: event.target.value },
                    }))}
                  >
                    {cakeClass.flavors.map((flavor) => <option key={flavor}>{flavor}</option>)}
                  </select>
                </label>
                <label className="menu-select-field">
                  <span>Weight</span>
                  <select
                    value={preview.weight}
                    onChange={(event) => {
                      const weight = Number(event.target.value);
                      const firstTier = cakeClass.combinations.find(
                        (entry) => entry.weight_lb === weight
                      )?.tiers || 1;
                      setCakePreviews((current) => ({
                        ...current,
                        [cakeClass.id]: { ...preview, weight, tiers: firstTier },
                      }));
                    }}
                  >
                    {weights.map((weight) => <option value={weight} key={weight}>{weight} lb</option>)}
                  </select>
                </label>
                <label className="menu-select-field">
                  <span>Tiers</span>
                  <select
                    value={selectedCombination?.tiers || 1}
                    onChange={(event) => setCakePreviews((current) => ({
                      ...current,
                      [cakeClass.id]: { ...preview, tiers: Number(event.target.value) },
                    }))}
                  >
                    {combinationsForWeight.map((entry) => (
                      <option value={entry.tiers} key={entry.tiers}>{entry.tiers}</option>
                    ))}
                  </select>
                </label>
                <label className={`menu-quantity-field${quantityError ? " invalid" : ""}`}>
                  <span>Qty</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    aria-invalid={!!quantityError}
                    value={preview.quantity}
                    onChange={(event) => setCakePreviews((current) => ({
                      ...current,
                      [cakeClass.id]: { ...preview, quantity: event.target.value },
                    }))}
                  />
                  {quantityError && <small>{quantityError}</small>}
                </label>
                <span className="menu-item-total">
                  <small>Cake total</small>
                  <strong>{previewTotal(drafts[selectedPriceId], preview.quantity)}</strong>
                </span>
              </div>
              <div className="cake-price-matrix">
                <div className="cake-price-matrix-heading">
                  <strong>Weight</strong><strong>Tier count</strong><strong>Base price</strong>
                </div>
                {cakeClass.combinations.map((combination) => (
                  <div className="cake-price-matrix-row" key={combination.id}>
                    <span>{combination.weight_lb} lb</span>
                    <span>{combination.tiers} {combination.tiers === 1 ? "tier" : "tiers"}</span>
                    {priceEditor(
                      "cakes",
                      combination.id,
                      `${cakeClass.name} ${combination.weight_lb} lb ${combination.tiers} tier`,
                      "price",
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  const activeCount = activeSource === "takeaway"
    ? menu.takeaway.item_count
    : activeSource === "catering"
      ? menu.catering.item_count
      : menu.cakes.flavor_count;
  const searchLabel = activeSource === "takeaway"
    ? "Search pickup & takeaway menu..."
    : activeSource === "catering"
      ? "Search catering menu..."
      : "Search cake flavors...";

  return (
    <div className="reference-page menu-reference-page catering-menu-page">
      <div className="menu-channel-tabs" aria-label="Menu type">
        <button className="active" type="button">Pickup &amp; Takeaway ({menu.takeaway.item_count})</button>
      </div>
      <div className="menu-action-row">
        <label className="reference-search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchLabel} /></label>
      </div>
      <div className="menu-state-message" role="note">Cake and catering requests are handled by the manager and are intentionally not listed as orderable menus.</div>
      {error && <div className="menu-state-message error" role="alert">{error}</div>}
      {success && <div className="menu-state-message success" role="status">{success}</div>}
      {loading
        ? <div className="reference-empty"><strong>Loading the pickup menu…</strong></div>
        : renderTakeaway()}
      <footer className="menu-unsaved-bar">
        <span className="menu-change-count">Read only</span>
        <p className="menu-unsaved-copy">This is the pickup menu currently used by the AI assistant.</p>
        <span className="menu-loaded-count">{activeCount} loaded</span>
      </footer>
    </div>
  );
}

export function AnalyticsScreen({ api, refreshKey }: { api: string; refreshKey: number }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      requestJson<Order[]>(`${api}/api/kitchen/orders`),
      requestJson<Conversation[]>(`${api}/api/conversations`),
    ]).then(([nextOrders, nextConversations]) => {
      if (!active) return;
      setOrders(nextOrders);
      setConversations(nextConversations);
      setFailed(false);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [api, refreshKey]);

  const revenue = orders.reduce((sum, order) => sum + total(order), 0);
  const completed = orders.filter((order) => order.status === "picked_up").length;
  const sources = orders.reduce<Record<string, number>>((result, order) => {
    const source = (order.channel || "unknown").toLowerCase();
    result[source] = (result[source] || 0) + 1;
    return result;
  }, {});
  const itemCounts = orders.flatMap((order) => order.items).reduce<Record<string, number>>((result, item) => {
    if (item.name) result[item.name] = (result[item.name] || 0) + (item.qty || item.quantity || 1);
    return result;
  }, {});
  const popular = Object.entries(itemCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return (
    <div className="reference-page analytics-reference-page">
      <div className="analytics-range"><span>▣</span> All available data</div>
      {failed && <div className="api-warning">Some analytics data is unavailable because the backend could not be reached.</div>}
      <div className="analytics-stat-grid">
        <article><span>▣</span><small>Total Revenue</small><strong>${revenue.toFixed(2)}</strong></article>
        <article><span>▤</span><small>Total Orders</small><strong>{orders.length}</strong></article>
        <article><span>✓</span><small>Completed Orders</small><strong>{completed}</strong></article>
        <article><span>◌</span><small>Conversations</small><strong>{conversations.length}</strong></article>
      </div>
      <section className="analytics-chart-card">
        <header><h2>Sales Overview</h2><p>Revenue by recent order</p></header>
        {orders.length === 0 ? <div className="reference-empty compact"><strong>No order data available</strong></div> : (
          <div className="bar-chart" aria-label="Revenue by recent order">
            {orders.slice(0, 18).reverse().map((order) => {
              const max = Math.max(...orders.map(total), 1);
              return <i key={order.id} style={{ height: `${Math.max(8, total(order) / max * 100)}%` }} title={`Order ${order.id}: $${total(order).toFixed(2)}`} />;
            })}
          </div>
        )}
      </section>
      <div className="analytics-bottom-grid">
        <section className="analytics-table-card">
          <h2>Popular Items</h2>
          {popular.length === 0 ? <div className="reference-empty compact"><strong>No item data available</strong></div> : (
            <table><thead><tr><th>Item Name</th><th>Orders</th></tr></thead><tbody>
              {popular.map(([name, count]) => <tr key={name}><td>{name}</td><td>{count}</td></tr>)}
            </tbody></table>
          )}
        </section>
        <section className="analytics-source-card">
          <h2>Order Sources</h2>
          {Object.keys(sources).length === 0 ? <div className="reference-empty compact"><strong>No source data available</strong></div> : (
            <div className="source-list">{Object.entries(sources).map(([source, count]) => (
              <div key={source}><span><i />{source}</span><strong>{Math.round(count / orders.length * 100)}%</strong></div>
            ))}</div>
          )}
        </section>
      </div>
      <p className="analytics-note">Metrics are calculated from the existing order and conversation APIs. Download reports and AI training insights are unavailable.</p>
    </div>
  );
}
