import { providerOf } from "./router";

/**
 * Per-request budgets. Free tiers are limited by tokens *per minute*, not by context
 * window: Groq's free tier rejects any single request above ~7k input tokens. Providers
 * listed in `forge.tightBudgetProviders` therefore get a compact profile; everyone else
 * gets a standard one. Every value can be overridden in settings (0 = use the profile).
 */
export interface BudgetProfile { name: "tight" | "standard"; contextBudget: number; maxResultChars: number; compactAt: number; maxOutputTokens: number }

const TIGHT: BudgetProfile = { name: "tight", contextBudget: 2200, maxResultChars: 5000, compactAt: 5200, maxOutputTokens: 3000 };
const STANDARD: BudgetProfile = { name: "standard", contextBudget: 7000, maxResultChars: 14000, compactAt: 40000, maxOutputTokens: 8192 };

export function profileFor(model: string, overrides: Partial<Record<keyof Omit<BudgetProfile, "name">, number>>, tightProviders: string[]): BudgetProfile {
  const base = tightProviders.includes(providerOf(model)) ? TIGHT : STANDARD;
  const pick = (key: keyof Omit<BudgetProfile, "name">) => (overrides[key] && overrides[key]! > 0 ? overrides[key]! : base[key]);
  return { name: base.name, contextBudget: pick("contextBudget"), maxResultChars: pick("maxResultChars"), compactAt: pick("compactAt"), maxOutputTokens: pick("maxOutputTokens") };
}
