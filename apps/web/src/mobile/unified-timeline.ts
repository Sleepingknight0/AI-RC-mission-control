import type { ProviderSessionProjectionItem } from "@aicl/protocol";

import type { TimelineItem } from "../state.js";

export type UnifiedTimelineEntry =
  | {
      source: "aicl";
      key: string;
      item: TimelineItem;
    }
  | {
      source: "provider_native";
      key: string;
      item: ProviderSessionProjectionItem;
    };

/**
 * A bound provider thread precedes its later AICL-managed work. Provider items
 * are retained in provider order; once an AICL Turn carries the exact same
 * provider Turn ID, AICL's durable projection wins for that Turn. Text, title,
 * timing, and filesystem similarity are deliberately never correlation keys.
 */
export function buildUnifiedTimeline(
  aiclItems: readonly TimelineItem[],
  providerItems: readonly ProviderSessionProjectionItem[],
): UnifiedTimelineEntry[] {
  const durableProviderTurns = new Set<string>();
  for (const entry of aiclItems) {
    if (
      (entry.kind === "operator" || entry.kind === "assistant") &&
      entry.turn.providerTurnId !== null
    ) {
      durableProviderTurns.add(entry.turn.providerTurnId);
    }
  }

  const nativeEntries: UnifiedTimelineEntry[] = [...providerItems]
    .sort((left, right) =>
      left.order - right.order ||
      left.providerItemId.localeCompare(right.providerItemId),
    )
    .filter((item) => !durableProviderTurns.has(item.providerTurnId))
    .map((item) => ({
      source: "provider_native" as const,
      key: `provider:${item.providerTurnId}:${item.providerItemId}`,
      item,
    }));

  return [
    ...nativeEntries,
    ...aiclItems.map((item) => ({
      source: "aicl" as const,
      key: `aicl:${item.id}`,
      item,
    })),
  ];
}
