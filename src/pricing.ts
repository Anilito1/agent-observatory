import { CostBreakdown, TokenTotals } from "./types";

// USD per 1M tokens. Defaults follow Anthropic's published rate structure
// (cache write 5m = 1.25x input, 1h = 2x input, cache read = 0.1x input).
// Fully overridable via the `agentObservatory.pricing` setting.
export interface ModelRate {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export const DEFAULT_RATES: Record<string, ModelRate> = {
  opus: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  sonnet: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  fable: { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
};

export function modelFamily(model: string): string {
  const m = (model || "").toLowerCase();
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  return "opus"; // safe default for unknown / future models
}

export class Pricing {
  private rates: Record<string, ModelRate>;

  constructor(overrides?: Record<string, Partial<ModelRate>>) {
    this.rates = JSON.parse(JSON.stringify(DEFAULT_RATES));
    if (overrides) {
      for (const [fam, rate] of Object.entries(overrides)) {
        this.rates[fam] = { ...(this.rates[fam] ?? DEFAULT_RATES.opus), ...rate };
      }
    }
  }

  cost(model: string, t: TokenTotals): CostBreakdown {
    const r = this.rates[modelFamily(model)] ?? DEFAULT_RATES.opus;
    const per = 1_000_000;
    const input = (t.input * r.input) / per;
    const output = (t.output * r.output) / per;
    const cacheWrite =
      (t.cacheWrite5m * r.cacheWrite5m) / per + (t.cacheWrite1h * r.cacheWrite1h) / per;
    const cacheRead = (t.cacheRead * r.cacheRead) / per;
    return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
  }
}

export function addTotals(a: TokenTotals, b: TokenTotals): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheWrite5m += b.cacheWrite5m;
  a.cacheWrite1h += b.cacheWrite1h;
  a.cacheRead += b.cacheRead;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
}

export function sumTokens(t: TokenTotals): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead;
}
