import type { Money, PayInterval, Quantity } from "@tallo/contracts";

/**
 * Heuristic extractors over free text. Everything they produce is flagged `inferred`.
 * Structured source fields always win over these; these only fill gaps.
 */

const SENTENCE_SPLIT = /(?<=[.!?\n])\s+/;
const PREFERRED = /\b(preferred|nice to have|a plus|bonus|ideally|desired)\b/i;

export function extractExperience(text: string): Quantity[] {
  const found: Quantity[] = [];
  const seen = new Set<string>();
  const patterns: RegExp[] = [
    /(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*years?/gi,
    /(?:minimum of|at least|min\.?)\s*(\d{1,2})\s*\+?\s*years?/gi,
    /(\d{1,2})\s*\+\s*years?/gi,
    /(\d{1,2})\s*years?(?:['’]s)?\s+(?:of\s+)?(?:\w+[ -]){0,3}?experience/gi,
  ];
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    if (!/years?/i.test(sentence)) continue;
    const kind = PREFERRED.test(sentence) ? "preferred" : "required";
    for (const pattern of patterns) {
      for (const m of sentence.matchAll(pattern)) {
        const a = Number(m[1]);
        const b = m[2] === undefined ? undefined : Number(m[2]);
        if (a > 40 || (b !== undefined && b > 40)) continue;
        const quantity: Quantity =
          b !== undefined && b >= a
            ? { min: a, max: b, unit: "years", kind, inferred: true, text: m[0].trim() }
            : { min: a, unit: "years", kind, inferred: true, text: m[0].trim() };
        const key = `${kind}:${quantity.min}:${quantity.max ?? ""}`;
        if (!seen.has(key) && found.length < 6) {
          seen.add(key);
          found.push(quantity);
        }
      }
    }
  }
  return found;
}

const MONEY_AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?([kK])?`;
const SYMBOLS: Record<string, string> = { "$": "USD", "£": "GBP", "€": "EUR" };

function interval(context: string, value: number): PayInterval {
  if (/\b(per|a|\/)\s?(year|yr|annum)|annual|yearly|\bp\.?a\.?\b/i.test(context)) return "year";
  if (/\b(per|an|\/)\s?(hour|hr)|hourly/i.test(context)) return "hour";
  if (/\b(per|a|\/)\s?month|monthly/i.test(context)) return "month";
  if (/\b(per|a|\/)\s?week|weekly/i.test(context)) return "week";
  if (/\b(per|a|\/)\s?day|daily/i.test(context)) return "day";
  if (value >= 20000) return "year";
  if (value > 0 && value < 500) return "hour";
  return "unknown";
}

export function extractCompensation(text: string): Money[] {
  const out: Money[] = [];
  const range = new RegExp(
    String.raw`([$£€])\s?${MONEY_AMOUNT}\s*(?:-|–|—|to)\s*(?:[$£€]\s?)?${MONEY_AMOUNT}`,
    "g",
  );
  const single = new RegExp(String.raw`([$£€])\s?${MONEY_AMOUNT}\s*(?:\+|per|/|a |an )`, "g");
  const scale = (n: string, k: string | undefined) => Number(n.replace(/,/g, "")) * (k ? 1000 : 1);
  const seen = new Set<string>();
  const push = (money: Money) => {
    const key = `${money.min}:${money.max}:${money.interval}`;
    if (!seen.has(key) && out.length < 4) {
      seen.add(key);
      out.push(money);
    }
  };
  for (const m of text.matchAll(range)) {
    let min = scale(m[2]!, m[3]);
    let max = scale(m[4]!, m[5]);
    if (m[5] && !m[3] && min < max / 100) min *= 1000; // "$120-150k"
    if (max < min) continue;
    const context = text.slice(m.index, (m.index ?? 0) + m[0].length + 60);
    const iv = interval(context, max);
    if (iv === "unknown" && max < 1000) continue;
    const currency = /\bCAD\b|canadian/i.test(context) ? "CAD" : SYMBOLS[m[1]!];
    push({ min, max, currency, interval: iv, component: "base", inferred: true, text: m[0] });
  }
  if (out.length === 0) {
    for (const m of text.matchAll(single)) {
      const value = scale(m[2]!, m[3]);
      const context = text.slice(m.index, (m.index ?? 0) + m[0].length + 40);
      const iv = interval(context, value);
      if (iv === "unknown" || (iv === "year" && value < 20000)) continue;
      push({ min: value, currency: SYMBOLS[m[1]!], interval: iv, component: "base", inferred: true, text: m[0] });
    }
  }
  return out;
}

const ANNUAL_FACTOR: Partial<Record<PayInterval, number>> = {
  year: 1, month: 12, week: 52, day: 260, hour: 2080,
};

/** Annualized base band for filtering. Currencies are never converted; the first band's wins. */
export function annualizeBase(bands: Money[]): { min: number | null; max: number | null; currency: string | null } {
  const usable = bands.filter(
    (b) => (b.component === "base" || b.component === "total" || b.component === "unknown") && ANNUAL_FACTOR[b.interval] && (b.min !== undefined || b.max !== undefined),
  );
  const structured = usable.filter((b) => !b.inferred);
  const pool = structured.length > 0 ? structured : usable;
  const first = pool[0];
  if (!first) return { min: null, max: null, currency: null };
  const currency = first.currency ?? null;
  const same = pool.filter((b) => (b.currency ?? null) === currency);
  const mins = same.map((b) => (b.min ?? b.max)! * ANNUAL_FACTOR[b.interval]!);
  const maxs = same.map((b) => (b.max ?? b.min)! * ANNUAL_FACTOR[b.interval]!);
  return { min: Math.round(Math.min(...mins)), max: Math.round(Math.max(...maxs)), currency };
}

/** Strictest required minimum and widest stated maximum, in years. */
export function summarizeExperience(quantities: Quantity[]): { min: number | null; max: number | null } {
  const years = quantities.filter((q) => q.unit === "years" && q.kind !== "preferred");
  const mins = years.map((q) => q.min ?? q.exact).filter((n): n is number => n !== undefined);
  const maxs = years.map((q) => q.max ?? q.exact).filter((n): n is number => n !== undefined);
  return {
    min: mins.length ? Math.max(...mins) : null,
    max: maxs.length ? Math.max(...maxs) : null,
  };
}
