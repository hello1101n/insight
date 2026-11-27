import type {
  ConnectorRun,
  ConnectorRunStage,
} from "@/api/connector-health-client";

import { parseStamp, type ConnectorTone } from "./connector-health";
import {
  describeRun,
  isActiveRun,
  isTerminalRunStatus,
  queueReason,
  queueTone,
  RUN_STEPS,
  stepFailure,
  stepForStage,
  type RunStep,
} from "./connector-runs";

interface Range {
  start: number;
  end: number;
}

type QueueRange = Range & {
  tone: ConnectorTone;
  reasons: string[];
};

export type RunSegment =
  (Range & { kind: RunStep }) | (QueueRange & { kind: "queued" });

interface StepTiming {
  step: RunStep;
  at: number | null;
  status: string;
  current: boolean;
  duration: number | null;
  queued: QueueTiming | undefined;
  failure: ConnectorRunStage | undefined;
}

interface QueueTiming {
  at: number;
  duration: number;
  tone: ConnectorTone;
  reasons: string[];
  current: boolean;
}

export interface RunTiming {
  start: number | null;
  end: number | null;
  steps: StepTiming[];
  segments: RunSegment[];
  queued: QueueTiming | undefined;
  currentQueue: QueueRange | undefined;
  trailingQueue: QueueTiming | undefined;
}

function strongestQueueTone(a: ConnectorTone, b: ConnectorTone): ConnectorTone {
  if (a === "failing" || b === "failing") return "failing";
  if (a === "unknown" || b === "unknown") return "unknown";
  return "idle";
}

function mergeQueue(ranges: QueueRange[]): QueueRange[] {
  const merged: QueueRange[] = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (!last || range.start > last.end) {
      merged.push({ ...range });
      continue;
    }

    last.end = Math.max(last.end, range.end);
    last.tone = strongestQueueTone(last.tone, range.tone);
    last.reasons = [...new Set([...last.reasons, ...range.reasons])];
  }
  return merged.map((range) => ({
    ...range,
    tone: queueTone(range.end - range.start, range.tone),
  }));
}

function mergeWork(ranges: Range[]): Range[] {
  const merged: Range[] = [];
  for (const range of ranges.toSorted((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end)
      last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function gapRanges(
  occupied: Range[],
  start: number,
  end: number
): QueueRange[] {
  const gaps: QueueRange[] = [];
  let cursor = start;
  for (const range of occupied.toSorted((a, b) => a.start - b.start)) {
    if (range.start > cursor)
      gaps.push({ start: cursor, end: range.start, reasons: [], tone: "idle" });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < end)
    gaps.push({ start: cursor, end, reasons: [], tone: "idle" });
  return gaps;
}

function queueTiming(
  ranges: QueueRange[],
  current: boolean
): QueueTiming | undefined {
  const first = ranges[0];
  if (!first) return undefined;

  const live = current ? ranges.at(-1) : undefined;
  return {
    at: first.start,
    duration: ranges.reduce((sum, range) => sum + range.end - range.start, 0),
    current,
    tone:
      live?.tone ??
      ranges.reduce<ConnectorTone>(
        (tone, range) => strongestQueueTone(tone, range.tone),
        "idle"
      ),
    reasons: live?.reasons ?? [
      ...new Set(ranges.flatMap((range) => range.reasons)),
    ],
  };
}

function stageTiming(stage: ConnectorRunStage, end: number | null) {
  const notStarted = stage.status === "not_started";
  const started = notStarted ? null : parseStamp(stage.started_at);
  const finished = parseStamp(stage.finished_at);
  const queued = parseStamp(stage.queued_at);
  const state = describeRun(stage.status);
  const expectedWork =
    !notStarted &&
    (started != null ||
      (state.kind !== "queued" &&
        stage.status !== "wait_timeout" &&
        state.kind !== "cancelled"));
  const stop =
    finished ??
    (!isTerminalRunStatus(stage.status) ? end : null) ??
    (started != null && stage.duration_ms != null && stage.duration_ms >= 0
      ? started + stage.duration_ms
      : end);
  const measured =
    started != null && stop != null && stop >= started ? stop - started : null;

  return {
    started,
    queued,
    stop,
    finished,
    expectedWork,
    duration: notStarted ? null : (stage.duration_ms ?? measured),
  };
}

export function summarizeRun(run: ConnectorRun, asOf: string): RunTiming {
  const active = isActiveRun(run);
  const start = parseStamp(run.started_at);
  const end = parseStamp(run.finished_at ?? (active ? asOf : null));
  const windows = run.stages.map((stage) => ({
    stage,
    step: stepForStage(stage.stage),
    ...stageTiming(stage, end),
  }));
  const occupied: Range[] = [];
  const work = new Map<RunStep, Range[]>();
  const waits: QueueRange[] = [];

  function range(from: number | null, to: number | null) {
    if (from == null || to == null) return null;
    const left = Math.max(start ?? from, from);
    const right = Math.min(end ?? to, to);
    return right > left ? { start: left, end: right } : null;
  }

  for (const window of windows) {
    const { stage, step, started, queued, stop, finished, expectedWork } =
      window;
    const state = describeRun(stage.status);
    const working = range(started, stop);
    if (step && working) {
      const ranges = work.get(step) ?? [];
      ranges.push(working);
      work.set(step, ranges);
    }
    const reserved = expectedWork
      ? range(started ?? queued ?? start, stop)
      : null;
    if (reserved) occupied.push(reserved);

    const waitEnd = started ?? finished ?? end;
    for (const wait of stage.waits ?? []) {
      const waiting = range(
        parseStamp(wait.started_at),
        parseStamp(wait.ended_at) ?? finished ?? end
      );
      if (!waiting) continue;
      waits.push({
        ...waiting,
        tone:
          state.kind === "queued" || state.state === "wait_timeout"
            ? state.tone
            : "idle",
        reasons: [queueReason(wait)],
      });
    }

    if (state.kind === "queued" || state.state === "wait_timeout") {
      const waiting = range(queued ?? start, waitEnd);
      if (waiting)
        waits.push({
          ...waiting,
          tone: state.tone,
          reasons: [],
        });
    }
  }

  const runState = describeRun(run.status);
  const knownQueue = active && runState.kind === "queued";
  const gaps =
    start != null && end != null && (windows.length > 0 || knownQueue)
      ? gapRanges(occupied, start, end)
      : [];
  const liveGap = gaps.at(-1);
  if (knownQueue && liveGap?.end === end) {
    liveGap.tone = runState.tone;
  }
  const queue = mergeQueue([...gaps, ...waits]);
  const currentWindow = active
    ? windows.findLast(
        ({ stage, finished }) =>
          finished == null && !isTerminalRunStatus(stage.status)
      )
    : undefined;
  const byStep = new Map<RunStep | undefined, QueueRange[]>();
  const anchors = windows
    .flatMap((window) => {
      const at =
        window.stage.status === "not_started" ||
        window.stage.status === "wait_timeout"
          ? window.finished
          : (window.started ?? (window.expectedWork ? window.queued : null));
      return at == null ? [] : [{ at, step: window.step }];
    })
    .sort((a, b) => a.at - b.at);

  for (const entry of queue) {
    const next = anchors.find(({ at }) => at >= entry.end);
    const waiting = windows.findLast(
      ({ stage, started, queued }) =>
        describeRun(stage.status).kind === "queued" &&
        started == null &&
        (queued == null || queued < entry.end)
    );
    const step = next?.step ?? waiting?.step;
    const entries = byStep.get(step) ?? [];
    entries.push(entry);
    byStep.set(step, entries);
  }

  const lastQueue = queue.at(-1);
  const currentQueue =
    active &&
    lastQueue?.end === end &&
    (!currentWindow ||
      describeRun(currentWindow.stage.status).kind === "queued")
      ? lastQueue
      : undefined;
  const workSegments: RunSegment[] = [];
  const steps = RUN_STEPS.flatMap((step): StepTiming[] => {
    const matching = windows.filter((window) => window.step === step);
    const last = matching.at(-1);
    if (!last) return [];

    const working = matching.filter((window) => window.expectedWork);
    const ranges = mergeWork(work.get(step) ?? []);
    workSegments.push(
      ...ranges.map((range): RunSegment => ({ ...range, kind: step }))
    );
    const measured =
      working.length > 0 &&
      working.every(
        ({ started, stop }) =>
          started != null && stop != null && started <= stop
      );
    const duration = measured
      ? ranges.reduce((sum, range) => sum + range.end - range.start, 0)
      : working.length === 1
        ? working[0].duration
        : null;
    const starts = working.flatMap((window) =>
      window.started == null ? [] : [window.started]
    );
    const failure =
      runState.kind === "failed"
        ? stepFailure(matching.map(({ stage }) => stage))
        : undefined;
    const entries = byStep.get(step) ?? [];
    const queued = queueTiming(
      entries,
      currentQueue != null && entries.at(-1) === currentQueue
    );
    const cancelled =
      runState.kind === "cancelled" &&
      last.finished == null &&
      !isTerminalRunStatus(last.stage.status);
    return [
      {
        step,
        at: starts.length ? Math.min(...starts) : last.finished,
        status: cancelled
          ? "cancelled"
          : (failure?.status ?? last.stage.status),
        current: currentWindow?.step === step && !currentQueue,
        duration,
        queued,
        failure,
      },
    ];
  });
  const segments: RunSegment[] = [
    ...workSegments,
    ...queue.map((entry): RunSegment => ({ ...entry, kind: "queued" })),
  ];
  return {
    start,
    end,
    steps,
    segments: segments.sort((a, b) => a.start - b.start),
    queued: queueTiming(queue, currentQueue != null),
    currentQueue,
    trailingQueue: currentQueue
      ? queueTiming(byStep.get(undefined) ?? [], true)
      : undefined,
  };
}
