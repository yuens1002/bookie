/**
 * Pure categorization-rule matching. No DB — callers load the rules (the tools
 * layer does that) and pass them in, so this stays deterministic and unit-testable.
 *
 * A rule matches when its `pattern` appears (case-insensitive) anywhere in the
 * transaction description. On conflict the winner is: highest `priority`, then
 * longest `pattern` (more specific), then input order (the loader sorts by
 * createdAt asc, and the sort below is stable, so the oldest rule wins a full tie).
 */

export type RuleAction = "categorize" | "exclude";

export interface RuleSpec {
  id: string;
  pattern: string;
  action: RuleAction;
  accountId: string | null;
  propertyId: string | null;
  priority: number;
}

export interface RuleMatch {
  ruleId: string;
  action: RuleAction;
  accountId: string | null;
  propertyId: string | null;
}

/** The highest-priority rule whose pattern is a substring of `description`, or null. */
export function matchRule(description: string, rules: RuleSpec[]): RuleMatch | null {
  const haystack = description.toLowerCase();
  const matched = rules.filter(
    (r) => r.pattern.trim() !== "" && haystack.includes(r.pattern.toLowerCase()),
  );
  if (matched.length === 0) return null;

  // Stable sort: priority desc, then longer pattern; ties keep input order.
  matched.sort((a, b) => b.priority - a.priority || b.pattern.length - a.pattern.length);
  const best = matched[0]!;
  return {
    ruleId: best.id,
    action: best.action,
    accountId: best.accountId,
    propertyId: best.propertyId,
  };
}
