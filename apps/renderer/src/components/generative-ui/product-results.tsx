"use client";

import { useMemo, useState } from "react";

import type { ProductCommand, ProductResultItem, ProductResultProps, ProductSort } from "../../../../../packages/contracts/src/ui/product-result";
import { UI_SCHEMA_VERSION } from "../../../../../packages/contracts/src/ui/common";
import styles from "./product-results.module.css";

export interface ProductResultsViewProps extends ProductResultProps {
  state?: "ready" | "loading" | "error";
  error_message?: string;
  onCommand?: (command: ProductCommand) => void;
  now?: Date;
}

function displayPrice(item: ProductResultItem): string {
  if (!item.price) return "Price unavailable";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: item.price.currency }).format(Number(item.price.amount));
  } catch {
    return `${item.price.amount} ${item.price.currency}`;
  }
}

function safeHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch { return undefined; }
}

export function ProductResults({ state = "ready", error_message, onCommand, now = new Date(), ...props }: ProductResultsViewProps) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<ProductSort>("default");
  const [announcement, setAnnouncement] = useState("");
  const sourceById = useMemo(() => new Map(props.sources.map((source) => [source.source_id, source])), [props.sources]);
  const items = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    const filtered = props.items.filter((item) => !needle || [item.name, item.merchant, ...item.attributes.flatMap((attribute) => [attribute.name, attribute.value])].some((value) => value.toLocaleLowerCase().includes(needle)));
    return filtered.map((item, index) => ({ item, index })).sort((left, right) => {
      if (sort === "name") return left.item.name.localeCompare(right.item.name) || left.index - right.index;
      if (sort === "price") {
        const a = left.item.price; const b = right.item.price;
        if (!a || !b || a.currency !== b.currency || a.unit !== b.unit) return left.index - right.index;
        return Number(a.amount) - Number(b.amount) || left.index - right.index;
      }
      return left.index - right.index;
    }).map(({ item }) => item);
  }, [filter, props.items, sort]);

  const staleAt = props.freshness.stale_after ? new Date(props.freshness.stale_after) : undefined;
  const isStale = staleAt ? staleAt <= now : false;
  const queryState = { query: props.query, filter, sort };
  const emit = (command_type: ProductCommand["command_type"]) => onCommand?.({ command_type, schema_version: UI_SCHEMA_VERSION, component_instance_id: props.component_instance_id, query_state: queryState });

  if (state === "loading") return <section className={styles.panel} aria-busy="true"><p role="status">Loading product results…</p></section>;
  if (state === "error") return <section className={styles.panel}><p role="alert">{error_message || "Product results could not be loaded. Nothing was changed."}</p><button type="button" onClick={() => emit("product.refresh")}>Try again</button></section>;

  return <section className={styles.panel} aria-labelledby={`${props.component_instance_id}-title`}>
    <header className={styles.header}>
      <div><p className={styles.eyebrow}>Generated product results</p><h2 id={`${props.component_instance_id}-title`}>{props.query || "Products"}</h2></div>
      <p className={styles.freshness}>{isStale ? "Stale results" : "Retrieved"} <time dateTime={props.freshness.retrieved_at}>{new Date(props.freshness.retrieved_at).toLocaleString()}</time></p>
    </header>
    {(isStale || props.warnings.length > 0) && <div className={styles.warning} role="status"><strong>{isStale ? "Results may be out of date." : "Some data is incomplete."}</strong>{props.warnings.map((warning) => <span key={`${warning.code}-${warning.message}`}>{warning.message}</span>)}</div>}
    <div className={styles.controls}>
      <label>Filter loaded results<input value={filter} onChange={(event) => { setFilter(event.target.value); setAnnouncement(`Showing locally filtered results`); }} /></label>
      <label>Sort<select value={sort} onChange={(event) => { const value = event.target.value as ProductSort; setSort(value); setAnnouncement(`Sorted by ${value}`); }}><option value="default">Recommended</option><option value="name">Name</option><option value="price">Price (same currency and unit)</option></select></label>
      {onCommand ? <button type="button" onClick={() => emit("product.filter")}>Search for more</button> : null}
      {onCommand ? <button type="button" onClick={() => emit("product.refresh")}>Refresh</button> : null}
    </div>
    <p className={styles.srOnly} aria-live="polite">{announcement || `${items.length} products shown`}</p>
    {items.length === 0 ? <p className={styles.empty}>No loaded products match this filter.</p> : <ul className={styles.list}>
      {items.map((item) => <li className={styles.card} key={item.id} tabIndex={0}>
        {item.image_url && <img src={item.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
        <div className={styles.body}><h3>{item.name}</h3><p className={styles.price}>{displayPrice(item)}{item.price?.unit ? ` / ${item.price.unit}` : ""}</p><p>{item.merchant} · {item.availability}</p>
          {item.attributes.length > 0 && <dl>{item.attributes.map((attribute) => <div key={`${attribute.name}-${attribute.value}`}><dt>{attribute.name}</dt><dd>{attribute.value}{attribute.unit ? ` ${attribute.unit}` : ""}</dd></div>)}</dl>}
          {item.partial_data_warnings.map((warning) => <p className={styles.itemWarning} key={warning}>Incomplete: {warning}</p>)}
          <p className={styles.sources}>Sources: {item.source_ids.map((id, index) => { const source = sourceById.get(id); const href = source && safeHref(source.url); return <span key={id}>{index > 0 ? ", " : ""}{source && href ? <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${source.title} (${new URL(href).hostname})`}>{source.title}</a> : id}</span>; })}</p>
        </div>
      </li>)}
    </ul>}
  </section>;
}
