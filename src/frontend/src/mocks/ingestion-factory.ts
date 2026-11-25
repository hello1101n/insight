import type {
  IngestionGrain,
  IngestionIntensity,
  IngestionPoint,
  IngestionSeries,
} from "@/api/ingestion-client";

const CONNECTORS: ReadonlyArray<readonly [string, number]> = [
  ["demo_tasks", 0.61],
  ["demo_chat", 0.32],
  ["demo_docs", 0.07],
];

const STREAMS_BY_CONNECTOR: Record<string, ReadonlyArray<readonly [string, number]>> = {
  bronze_demo_tasks: [
    ["issues", 0.59],
    ["comments", 0.28],
    ["boards", 0.13],
  ],
  bronze_demo_chat: [
    ["messages", 0.87],
    ["channels", 0.13],
  ],
  bronze_demo_docs: [["pages", 1]],
};

const MS = { "15m": 15 * 60 * 1_000, "1s": 1_000 } as const;

const PEAK_15M = 6_800;

const PEAK_1S = 13;

function noise(epoch: number, salt: number): number {
  let hash = 0x811c9dc5 ^ salt;
  const text = String(epoch);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function unit(epoch: number, salt: number): number {
  return (noise(epoch, salt) % 10_000) / 10_000;
}

function bucketTotal(epoch: number, grain: IngestionGrain): number {
  const at = new Date(epoch);
  const hour = at.getUTCHours();
  const weekday = at.getUTCDay() >= 1 && at.getUTCDay() <= 5;

  if (unit(epoch, 1) < 0.04) return 0;
  if (unit(epoch, 2) < 0.05) return 1;

  if (grain === "1s") {
    return 1 + Math.floor(unit(epoch, 3) * PEAK_1S);
  }
  const daily = hour >= 7 && hour <= 18 ? 1 : 0.12;
  const weekly = weekday ? 1 : 0.25;
  const jitter = 0.15 + unit(epoch, 4) * 0.85;
  return Math.max(1, Math.round(PEAK_15M * daily * weekly * jitter * 0.42));
}

function bandsFor(series: IngestionSeries, scope: string | null) {
  if (series === "total") return [["all", 1]] as ReadonlyArray<readonly [string, number]>;
  if (series === "stream") {
    return STREAMS_BY_CONNECTOR[scope ?? ""] ?? [["stream_a", 1]];
  }
  return CONNECTORS;
}

function splitBucket(
  epoch: number,
  total: number,
  bands: ReadonlyArray<readonly [string, number]>,
): Array<{ key: string; rows: number }> {
  const out: Array<{ key: string; rows: number }> = [];
  bands.forEach(([key, share], index) => {
    const wobble = 0.7 + unit(epoch, 10 + index) * 0.6;
    const rows = Math.round(total * share * wobble);
    if (rows > 0) out.push({ key, rows });
  });
  if (out.length === 0) out.push({ key: bands[0][0], rows: 1 });
  return out;
}

function stamp(epoch: number, grain: IngestionGrain): string {
  const iso = new Date(epoch).toISOString();
  return grain === "1s"
    ? `${iso.slice(0, 10)} ${iso.slice(11, 23)}`
    : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`;
}

export interface IngestionMockRequest {
  grain: IngestionGrain;
  series?: IngestionSeries;
  scope?: string | null;
  from?: string | null;
  to?: string | null;
  now?: number;
}

function defaultSpanMs(grain: IngestionGrain): number {
  return grain === "1s" ? 30 * 60 * 1_000 : 24 * 60 * 60 * 1_000;
}

export function buildIngestionIntensity(
  req: IngestionMockRequest,
): IngestionIntensity {
  const grain = req.grain;
  const scope = req.scope || null;
  const series: IngestionSeries = req.series ?? (scope ? "stream" : "connector");
  const now = req.now ?? Date.now();

  const to = req.to ? Date.parse(req.to) : now;
  const from = req.from ? Date.parse(req.from) : to - defaultSpanMs(grain);
  const step = MS[grain];

  const bands = bandsFor(series, scope);
  const points: IngestionPoint[] = [];
  const first = Math.ceil(from / step) * step;
  for (let epoch = first; epoch < to; epoch += step) {
    const total = bucketTotal(epoch, grain);
    if (total === 0) continue;
    const bucket = stamp(epoch, grain);
    for (const band of splitBucket(epoch, total, bands)) {
      points.push({ bucket, key: band.key, rows: band.rows });
    }
  }

  const body: IngestionIntensity = {
    grain,
    series,
    from: new Date(from).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    to: new Date(to).toISOString().replace(/\.\d{3}Z$/, ".000Z"),
    truncated: false,
    points,
  };
  if (scope) body.scope = scope;
  return body;
}
