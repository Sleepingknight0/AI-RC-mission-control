import type { ProviderSessionProjectionItem } from "@aicl/protocol";

export function NativeTimelineEntry({
  item,
  position,
  setSize,
}: {
  item: ProviderSessionProjectionItem;
  position: number;
  setSize: number;
}) {
  const feedProps = {
    role: "article",
    "aria-posinset": position,
    "aria-setsize": setSize,
  } as const;

  if (item.type === "operator_message") {
    return (
      <article className="timeline-entry operator-entry native-timeline-entry" {...feedProps}>
        <div className="entry-meta"><span>OPERATOR · PROVIDER NATIVE</span></div>
        <p className="native-message-copy">{item.text}</p>
      </article>
    );
  }

  if (item.type === "assistant_message" || item.type === "assistant_progress") {
    const progress = item.type === "assistant_progress";
    return (
      <article className="timeline-entry assistant-entry native-timeline-entry" {...feedProps}>
        <div className="entry-meta">
          <span>{progress ? "ASSISTANT PROGRESS" : item.phase === "final_answer" ? "ASSISTANT FINAL" : "ASSISTANT"}</span>
          {item.status === "streaming" && <span className="native-live-marker">LIVE</span>}
        </div>
        <p className="native-message-copy">{item.text}</p>
      </article>
    );
  }

  if (item.type === "activity") {
    return (
      <article className="timeline-entry machine-entry native-timeline-entry native-activity-entry" {...feedProps}>
        <details open={item.status === "running" || item.status === "waiting"}>
          <summary>
            <span className="native-activity-status" data-state={item.status}>
              {item.status.toUpperCase()}
            </span>
            <strong>{item.title}</strong>
          </summary>
          <div className="native-activity-detail">
            <dl>
              <div><dt>Activity</dt><dd>{activityLabel(item.activityType)}</dd></div>
              {item.cwdLabel !== null && <div><dt>Project</dt><dd>{item.cwdLabel}</dd></div>}
              {item.durationMs !== null && <div><dt>Elapsed</dt><dd>{durationLabel(item.durationMs)}</dd></div>}
            </dl>
            {item.combinedOutputPreview !== null && (
              <section aria-label="Combined provider output preview">
                <h4>Output preview</h4>
                <pre>{item.combinedOutputPreview}</pre>
              </section>
            )}
            {item.stdoutPreview !== null && (
              <section aria-label="Standard output preview">
                <h4>Stdout preview</h4>
                <pre>{item.stdoutPreview}</pre>
              </section>
            )}
            {item.stderrPreview !== null && (
              <section aria-label="Standard error preview">
                <h4>Stderr preview</h4>
                <pre>{item.stderrPreview}</pre>
              </section>
            )}
          </div>
        </details>
      </article>
    );
  }

  if (item.type === "file_change") {
    return (
      <article className="timeline-entry file-entry native-timeline-entry" {...feedProps}>
        <div className="entry-meta">
          <span>FILE CHANGE · PROVIDER NATIVE</span>
          <span>{item.status.toUpperCase()}</span>
        </div>
        <ul className="native-file-list">
          {item.files.map((file) => (
            <li key={`${file.kind}:${file.path}`}>
              <span aria-hidden="true">{file.kind === "add" ? "+" : file.kind === "delete" ? "−" : "~"}</span>
              <span>{file.path}</span>
            </li>
          ))}
        </ul>
      </article>
    );
  }

  return (
    <article className="timeline-entry machine-entry native-timeline-entry native-turn-state" {...feedProps}>
      <div className="entry-meta"><span>REMOTE TURN</span></div>
      <strong>{stateLabel(item.state).toUpperCase()}</strong>
      {item.failureCode !== null && <p>{item.failureCode}</p>}
    </article>
  );
}

function activityLabel(value: Extract<ProviderSessionProjectionItem, { type: "activity" }>["activityType"]) {
  const labels = {
    command: "Command",
    read_file: "Reading file",
    search: "Search",
    edit: "Editing",
    test: "Running tests",
    tool: "Tool",
    web_search: "Web search",
    subagent: "Sub-agent",
    waiting: "Waiting",
  } as const;
  return labels[value];
}

function stateLabel(value: Extract<ProviderSessionProjectionItem, { type: "turn_state" }>["state"]) {
  return value.replaceAll("_", " ");
}

function durationLabel(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
