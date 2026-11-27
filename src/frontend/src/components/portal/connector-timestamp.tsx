import { UNMEASURED, connectorTimestamp } from "@/lib/portal/connector-health";

export function ConnectorTimestamp({
  value,
  className,
  showZone = false,
}: {
  value: string | null | undefined;
  className?: string;
  showZone?: boolean;
}) {
  const stamp = connectorTimestamp(value);
  if (!stamp) return <span className={className}>{UNMEASURED}</span>;

  return (
    <time dateTime={stamp.iso} title={stamp.iso} className={className}>
      <span className="whitespace-nowrap">{stamp.date}</span>
      <span aria-hidden="true" className="hidden sm:inline">
        {" ·"}
      </span>{" "}
      <span className="whitespace-nowrap">
        {stamp.time}
        {showZone && " UTC"}
      </span>
    </time>
  );
}

export function ConnectorRunPeriod({
  startedAt,
  finishedAt,
}: {
  startedAt: string | null | undefined;
  finishedAt: string | null | undefined;
}) {
  const finished = connectorTimestamp(finishedAt);
  if (!finished) return <ConnectorTimestamp value={startedAt} showZone />;

  const sameDay = connectorTimestamp(startedAt)?.date === finished.date;
  return (
    <>
      <ConnectorTimestamp value={startedAt} />
      {" – "}
      {sameDay ? (
        <time
          dateTime={finished.iso}
          title={finished.iso}
          className="whitespace-nowrap"
        >
          {finished.time} UTC
        </time>
      ) : (
        <ConnectorTimestamp value={finishedAt} showZone />
      )}
    </>
  );
}
