export function MobileAuthorityBanner({
  label,
  reason,
  canRetry,
  retryPending,
  onRetry,
}: {
  label: string;
  reason: string;
  canRetry: boolean;
  retryPending: boolean;
  onRetry: () => void;
}) {
  return (
    <section className="mobile-state-banner" role="status">
      <strong>{label}</strong>
      <p>{reason}</p>
      {canRetry && (
        <button
          type="button"
          className="secondary-button"
          disabled={retryPending}
          onClick={onRetry}
        >
          {retryPending ? "Retrying…" : "Retry binding"}
        </button>
      )}
    </section>
  );
}
