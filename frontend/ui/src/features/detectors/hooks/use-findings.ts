import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";

/** Snake-case shape returned by the backend for a trace's findings */
export interface BackendFinding {
  finding_id: string;
  trace_id: string;
  project_id: string;
  timestamp: string;
  summary: string;
  payload: string;
}

/** How a run's `rca_status` renders in the "Agent analysis" column. */
export interface RcaStatusPresentation {
  label: string;
  className: string;
  title?: string;
}

/**
 * Single source of truth for the agent-analysis status vocabulary:
 * absent field (enrichment unavailable) -> "—", null (no stored RCA row) ->
 * "Skipped", terminal/in-flight statuses -> their labels. An unrecognized
 * future status renders as its raw value rather than a misleading "Running…".
 */
export function describeRcaStatus(status: BackendRun["rca_status"]): RcaStatusPresentation {
  if (status === undefined) {
    return { label: "—", className: "font-mono text-[11px] text-muted-foreground" };
  }
  if (status === null) {
    return {
      label: "Skipped",
      className: "text-muted-foreground",
      title: "Root cause analysis was off for the detector(s) that fired",
    };
  }
  if (status === "failed") return { label: "Failed", className: "text-destructive" };
  if (status === "done") return { label: "Done", className: "text-foreground" };
  if (status === "pending" || status === "running") {
    return { label: "Running…", className: "text-muted-foreground" };
  }
  return { label: status, className: "text-muted-foreground" };
}

/** Pagination metadata returned alongside data arrays. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
}

async function fetchTraceFindings(
  projectId: string,
  traceId: string,
): Promise<{ findings: BackendFinding[] }> {
  const url = `/api/projects/${projectId}/traces/${traceId}/findings`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ detail: `Failed to fetch trace findings: ${res.status}` }));
    throw new ApiError(res.status, body.detail ?? `Failed to fetch trace findings: ${res.status}`);
  }
  return res.json() as Promise<{ findings: BackendFinding[] }>;
}

export interface DetectorRca {
  id: string;
  findingId: string;
  sessionId: string | null;
  status: "pending" | "running" | "done" | "failed";
  result: string | null;
  completedAt: string | null;
  createTime: string;
}

async function fetchRca(
  projectId: string,
  findingId: string,
): Promise<{ rca: DetectorRca | null }> {
  const url = `/api/projects/${projectId}/findings/${findingId}/rca`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: `Failed to fetch RCA: ${res.status}` }));
    throw new ApiError(res.status, body.detail ?? `Failed to fetch RCA: ${res.status}`);
  }
  return res.json() as Promise<{ rca: DetectorRca | null }>;
}

// Detector findings/runs/RCA are produced asynchronously by the worker after a
// trace is ingested, so a trace opened live starts with none. We poll after open
// so the Alert button, Detectors tab and RCA answer appear without a manual
// refresh, then stop.
//
// When to stop is driven by the authoritative per-trace detection state
// (useTraceDetectionState) rather than a guess:
//   - "sampled_out": conditions/sampling rejected every detector, so nothing
//     will ever appear — stop immediately and poll not at all.
//   - "pending" with detectorIds: exactly those runs are expected, so stop the
//     moment they have all landed.
// The elapsed window below is only a safety net for when that signal is absent
// (record expired past its TTL, Redis down, trace opened before the claim was
// written) or when an expected run never materializes because its job died.
//
// The window has to comfortably exceed the pipeline's latency: evaluation is
// deliberately debounced (the worker waits for the trace to go quiet — see
// EVALUATOR_DELAY, ~60s) and jobs run under a 1-hour Celery visibility timeout
// with no short cap, so a too-short window quits before anything exists and
// forces the manual refresh this all exists to avoid.
export const TRACE_POLL_INTERVAL_MS = 3000;
export const TRACE_POLL_WINDOW_MS = 300000;

/** Worker enqueue-claim state for a trace; `null` means "no signal". */
export type DetectionStateValue = "deciding" | "pending" | "sampled_out" | null;

export interface TraceDetectionState {
  state: DetectionStateValue;
  /** Detectors enqueued for this trace. Populated only when state is "pending". */
  detectorIds: string[];
}

/**
 * True when detection is authoritatively known to produce nothing for this
 * trace, so the page should neither poll nor promise pending results.
 */
export function detectionRuledOut(detection: TraceDetectionState | undefined): boolean {
  return detection?.state === "sampled_out";
}

/**
 * True while detection is queued or being decided — the honest "working" signal,
 * available before any finding or run exists.
 */
export function detectionInFlight(detection: TraceDetectionState | undefined): boolean {
  return detection?.state === "pending" || detection?.state === "deciding";
}

/**
 * Poll cadence for the trace-page findings query. Stops once a finding exists
 * (the Alert button renders and useRca takes over the RCA status) or when
 * detection is ruled out; otherwise falls back to the safety-net window. Pure +
 * exported so the decision is unit-tested without driving a real interval.
 */
export function findingsPollInterval(
  findingCount: number,
  elapsedMs: number,
  detection?: TraceDetectionState,
): number | false {
  if (findingCount > 0) return false;
  if (detectionRuledOut(detection)) return false;
  return elapsedMs < TRACE_POLL_WINDOW_MS ? TRACE_POLL_INTERVAL_MS : false;
}

/**
 * Poll cadence for the trace-page detector-runs query. Runs are written only
 * when a detector finishes evaluating, so there is no in-flight row to watch —
 * instead we stop as soon as every enqueued detector has a run (the precise
 * completion signal), or immediately when detection is ruled out, and otherwise
 * fall back to the window. Pure + exported for unit testing.
 */
export function detectorRunsPollInterval(
  runCount: number,
  elapsedMs: number,
  detection?: TraceDetectionState,
): number | false {
  if (detectionRuledOut(detection)) return false;
  const expected = detection?.state === "pending" ? detection.detectorIds.length : 0;
  if (expected > 0 && runCount >= expected) return false;
  return elapsedMs < TRACE_POLL_WINDOW_MS ? TRACE_POLL_INTERVAL_MS : false;
}

/**
 * Poll cadence for the detection-state record itself. "pending" and
 * "sampled_out" are sticky for the record's TTL, so once either is read there is
 * nothing further to learn; only the transient "deciding" is worth re-reading.
 * A missing record is not re-polled — that would add a standing poll to every
 * historical trace view for a race the results window already covers.
 */
export function detectionStatePollInterval(state: DetectionStateValue): number | false {
  return state === "deciding" ? TRACE_POLL_INTERVAL_MS : false;
}

/**
 * Poll cadence for a finding's RCA. Polls while the run is in flight
 * (pending/running). Crucially, it ALSO polls while the row does not exist yet
 * (status undefined) but only within the window: the worker writes the finding
 * first and creates the DetectorRca row a moment later, so a just-surfaced
 * finding briefly has no row. Without this the query would stop on that first
 * empty fetch and the Alert button would need a manual refresh to appear. A
 * detector with RCA disabled never creates a row, so the window bounds that
 * case. Stops on a terminal status (done/failed). Pure + exported for testing.
 */
export function rcaPollInterval(
  status: DetectorRca["status"] | undefined,
  elapsedMs: number,
): number | false {
  if (status === "pending" || status === "running") return TRACE_POLL_INTERVAL_MS;
  if (status === undefined) {
    return elapsedMs < TRACE_POLL_WINDOW_MS ? TRACE_POLL_INTERVAL_MS : false;
  }
  return false; // done | failed
}

/**
 * Returns a getter for milliseconds elapsed since `key` last changed. Used to
 * time-box polling per key: switching trace/finding restarts the window so the
 * freshly-opened target gets its own grace period to wait for the worker.
 */
function useElapsedSince(key: string): () => number {
  const ref = useRef<{ key: string; at: number }>({ key, at: Date.now() });
  if (ref.current.key !== key) ref.current = { key, at: Date.now() };
  return () => Date.now() - ref.current.at;
}

export function useRca(projectId: string, findingId: string) {
  const elapsed = useElapsedSince(findingId);
  return useQuery({
    queryKey: ["detector-rca", projectId, findingId],
    queryFn: () => fetchRca(projectId, findingId),
    enabled: !!projectId && !!findingId,
    refetchInterval: (query) => rcaPollInterval(query.state.data?.rca?.status, elapsed()),
  });
}

/** Snake-case shape returned by the backend for a single detector run */
export interface BackendRun {
  run_id: string;
  detector_id: string;
  project_id: string;
  trace_id: string;
  finding_id: string | null;
  status: string;
  timestamp: string;
  /** Per-detector summary from the finding payload. Empty string when not triggered. */
  summary: string;
  /**
   * Human-readable detector name, joined in the trace-detector-runs proxy.
   * Falls back to `detector_id` when the detector was deleted.
   */
  name?: string;
  /**
   * Stored RCA status for a triggered run, enriched by the runs proxy route.
   * null = no DetectorRca row (RCA skipped — disabled on every detector that
   * fired); absent = enrichment unavailable or the run never triggered.
   */
  rca_status?: "pending" | "running" | "done" | "failed" | null;
}

export interface RunsQuery {
  page?: number;
  limit?: number;
  start_after?: string;
  end_before?: string;
  search_query?: string;
  /** When true, return only triggered runs (finding_id IS NOT NULL). */
  identified?: boolean;
}

export interface RunsResponse {
  data: BackendRun[];
  meta: PaginationMeta;
}

async function fetchRuns(
  projectId: string,
  detectorId: string,
  query: RunsQuery = {},
): Promise<RunsResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.start_after) params.set("start_after", query.start_after);
  if (query.end_before) params.set("end_before", query.end_before);
  if (query.search_query) params.set("search_query", query.search_query);
  if (query.identified) params.set("identified", "true");

  const qs = params.toString();
  const url = `/api/projects/${projectId}/detectors/${detectorId}/runs${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: `Failed to fetch runs: ${res.status}` }));
    throw new ApiError(res.status, body.detail ?? `Failed to fetch runs: ${res.status}`);
  }
  return res.json() as Promise<RunsResponse>;
}

export function useRuns(projectId: string, detectorId: string, query: RunsQuery = {}) {
  return useQuery({
    queryKey: [
      "detector-runs",
      projectId,
      detectorId,
      query.page ?? 0,
      query.limit ?? 50,
      query.search_query ?? null,
      query.start_after ?? null,
      query.end_before ?? null,
      query.identified ?? false,
    ],
    queryFn: () => fetchRuns(projectId, detectorId, query),
    enabled: !!projectId && !!detectorId,
  });
}

const EMPTY_DETECTION: TraceDetectionState = { state: null, detectorIds: [] };

/**
 * Reads the trace's detection state. Fails soft to an empty state: this is a
 * freshness hint that gates polling, so an outage must degrade to the window
 * fallback rather than error the page.
 */
async function fetchTraceDetectionState(
  projectId: string,
  traceId: string,
): Promise<TraceDetectionState> {
  const res = await fetch(`/api/projects/${projectId}/traces/${traceId}/detection-state`);
  if (!res.ok) return EMPTY_DETECTION;
  const data = (await res.json()) as { state?: string | null; detector_ids?: unknown };
  return {
    state: (data.state ?? null) as DetectionStateValue,
    detectorIds: Array.isArray(data.detector_ids)
      ? data.detector_ids.filter((d): d is string => typeof d === "string")
      : [],
  };
}

/**
 * Authoritative answer to "is detection going to produce anything for this
 * trace, and what should we expect?" — lets the trace page show a working state
 * immediately and stop polling precisely, instead of guessing with a timer.
 */
export function useTraceDetectionState(projectId: string, traceId: string) {
  return useQuery({
    queryKey: ["trace-detection-state", projectId, traceId],
    queryFn: () => fetchTraceDetectionState(projectId, traceId),
    enabled: !!projectId && !!traceId,
    refetchInterval: (query) => detectionStatePollInterval(query.state.data?.state ?? null),
  });
}

export function useTraceFindings(projectId: string, traceId: string) {
  const elapsed = useElapsedSince(traceId);
  // Self-gated on the detection state so call sites need no plumbing; React
  // Query dedupes this against the panel's own subscription to the same key.
  const { data: detection } = useTraceDetectionState(projectId, traceId);
  return useQuery({
    queryKey: ["trace-findings", projectId, traceId],
    queryFn: () => fetchTraceFindings(projectId, traceId),
    enabled: !!projectId && !!traceId,
    refetchInterval: (query) =>
      findingsPollInterval(query.state.data?.findings?.length ?? 0, elapsed(), detection),
  });
}

async function fetchTraceDetectorRuns(
  projectId: string,
  traceId: string,
): Promise<{ runs: BackendRun[] }> {
  const url = `/api/projects/${projectId}/traces/${traceId}/detector-runs`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ detail: `Failed to fetch trace detector runs: ${res.status}` }));
    throw new ApiError(
      res.status,
      body.detail ?? `Failed to fetch trace detector runs: ${res.status}`,
    );
  }
  return res.json() as Promise<{ runs: BackendRun[] }>;
}

export function useTraceDetectorRuns(projectId: string, traceId: string) {
  const elapsed = useElapsedSince(traceId);
  const { data: detection } = useTraceDetectionState(projectId, traceId);
  return useQuery({
    queryKey: ["trace-detector-runs", projectId, traceId],
    queryFn: () => fetchTraceDetectorRuns(projectId, traceId),
    enabled: !!projectId && !!traceId,
    refetchInterval: (query) =>
      detectorRunsPollInterval(query.state.data?.runs?.length ?? 0, elapsed(), detection),
  });
}
