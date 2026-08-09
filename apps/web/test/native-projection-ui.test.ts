import { readFileSync } from "node:fs";

import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderSessionProjectionItem } from "@aicl/protocol";

import { NativeTimelineEntry } from "../src/mobile/NativeTimelineEntry.js";
import { MobileChatTimeline } from "../src/mobile/MobileChatTimeline.js";

describe("provider-native remote timeline UI", () => {
  it("renders live progress separately from the final assistant answer", () => {
    const progress = render(item({
      type: "assistant_progress",
      progressType: "commentary",
      status: "streaming",
      text: "Inspecting files",
    }));
    const answer = render(item({
      type: "assistant_message",
      phase: "final_answer",
      status: "completed",
      text: "Done",
    }));

    expect(progress).toContain("ASSISTANT PROGRESS");
    expect(progress).toContain("LIVE");
    expect(answer).toContain("ASSISTANT FINAL");
    expect(answer).not.toContain("ASSISTANT PROGRESS");
  });

  it("renders a bounded expandable command card without raw transport data", () => {
    const html = render(item({
      type: "activity",
      activityType: "test",
      status: "running",
      title: "pnpm test --filter a-very-long-command-name-that-must-wrap",
      cwdLabel: "mission-control",
      durationMs: 8_000,
      combinedOutputPreview: "tests running",
      stdoutPreview: null,
      stderrPreview: null,
    }));

    expect(html).toContain("<details");
    expect(html).toContain("RUNNING");
    expect(html).toContain("mission-control");
    expect(html).toContain("00:08");
    expect(html).toContain("tests running");
    expect(html).not.toContain("providerEvent");
    expect(html).not.toContain("processId");
  });

  it("renders sanitized file activity and terminal Turn state", () => {
    const file = render(item({
      type: "file_change",
      status: "completed",
      files: [{ path: "src/native.ts", kind: "update" }],
    }));
    const turn = render(item({
      type: "turn_state",
      state: "interrupted",
      startedAt: "2026-08-09T08:00:00.000Z",
      completedAt: "2026-08-09T08:00:10.000Z",
      failureCode: null,
    }));

    expect(file).toContain("src/native.ts");
    expect(file).toContain("FILE CHANGE");
    expect(turn).toContain("INTERRUPTED");
  });

  it("never describes unavailable provider history as an empty AICL Session", () => {
    const unavailable = renderToStaticMarkup(createElement(MobileChatTimeline, {
      busy: false,
      loading: false,
      empty: true,
      providerNative: true,
      unavailable: true,
      unreadUpdates: 0,
      timelineRef: createRef<HTMLDivElement>(),
      onScroll: () => undefined,
      onReturnToLive: () => undefined,
      children: null,
    }));
    const historyEmpty = renderToStaticMarkup(createElement(MobileChatTimeline, {
      busy: false,
      loading: false,
      empty: true,
      providerNative: true,
      unavailable: false,
      unreadUpdates: 0,
      timelineRef: createRef<HTMLDivElement>(),
      onScroll: () => undefined,
      onReturnToLive: () => undefined,
      children: null,
    }));

    expect(unavailable).toContain("Provider history unavailable");
    expect(unavailable).not.toContain("no turns yet");
    expect(historyEmpty).toContain("No provider history yet");
    expect(historyEmpty).not.toContain("Start a conversation");
  });

  it("keeps native observation separate from every mutation command", () => {
    const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    const observe = source.slice(
      source.indexOf("const observeNativeSession"),
      source.indexOf("const selectMobileAccount"),
    );
    expect(observe).toContain("requestNativeProjection");
    expect(observe).not.toContain('makeEnvelope("turn.submit"');
    expect(observe).not.toContain('makeEnvelope("session.resume"');
    expect(observe).not.toContain('makeEnvelope("provider.account.activate"');
    expect(source).toContain("onObserveNative={observeNativeSession}");
  });
});

type WithoutIdentity<T> = T extends unknown
  ? Omit<T, "providerTurnId" | "providerItemId" | "order">
  : never;

function item(
  value: WithoutIdentity<ProviderSessionProjectionItem>,
): ProviderSessionProjectionItem {
  return {
    ...value,
    providerTurnId: "turn-1",
    providerItemId: `item-${value.type}`,
    order: 0,
  } as ProviderSessionProjectionItem;
}

function render(value: ProviderSessionProjectionItem) {
  return renderToStaticMarkup(
    createElement(NativeTimelineEntry, {
      item: value,
      position: 1,
      setSize: 1,
    }),
  );
}
