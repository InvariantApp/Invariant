/**
 * The proxy's counters in Prometheus's text format, under the names the
 * design gives them (DESIGN 11.3).
 *
 * Labelled by contract, direction, Change and reason, never by path: a path
 * carries ids, and one label value per payment is a metrics system brought
 * down by its own traffic. Nothing here holds a body or a value from one.
 */
import type { OutcomeEvent, UsageEvent } from "@invariant-app/runtime";

type Labels = Record<string, string>;

interface Family {
  help: string;
  series: Map<string, { labels: Labels; value: number }>;
}

export interface Metrics {
  outcome(event: OutcomeEvent): void;
  usage(event: UsageEvent): void;
  /** Everything counted so far, as a scrape reads it. */
  render(): string;
}

/** A label value as the text format writes it. */
function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export function createMetrics(): Metrics {
  const families = new Map<string, Family>();
  const family = (name: string, help: string) => {
    families.set(name, { help, series: new Map() });
    return name;
  };
  const adapted = family(
    "invariant_adapted_total",
    "Requests, responses and payloads adapted to a caller's contract.",
  );
  const applied = family(
    "invariant_change_applied_total",
    "Times a Change was applied for a caller on an old contract.",
  );
  const refused = family(
    "invariant_refused_total",
    "Requests refused before the provider's handler ran, so nothing happened.",
  );
  const unsupported = family(
    "invariant_unsupported_contract_total",
    "Requests naming a contract that does not exist or is switched off.",
  );
  const failed = family(
    "invariant_transform_error_total",
    "Answers that could not be expressed in the caller's contract after the operation ran.",
  );

  const add = (name: string, labels: Labels, count = 1) => {
    const series = (families.get(name) as Family).series;
    const key = JSON.stringify(labels);
    const held = series.get(key);
    if (held) held.value += count;
    else series.set(key, { labels, value: count });
  };

  return {
    outcome(event) {
      const labels = { contract: event.contract, direction: event.direction };
      if (event.outcome === "adapted") add(adapted, labels);
      else if (event.outcome === "failed") add(failed, labels);
      else {
        add(refused, { ...labels, reason: event.reason ?? "unknown" });
        if (event.reason === "UnsupportedContractError") {
          add(unsupported, { contract: event.contract });
        }
      }
    },
    usage(event) {
      for (const [change, count] of event.changes) {
        add(applied, { contract: event.contract, change }, count);
      }
    },
    render() {
      const lines: string[] = [];
      for (const [name, { help, series }] of families) {
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`);
        for (const { labels, value } of series.values()) {
          const text = Object.entries(labels)
            .map(([key, label]) => `${key}="${escapeLabel(label)}"`)
            .join(",");
          lines.push(`${name}{${text}} ${value}`);
        }
      }
      return `${lines.join("\n")}\n`;
    },
  };
}
