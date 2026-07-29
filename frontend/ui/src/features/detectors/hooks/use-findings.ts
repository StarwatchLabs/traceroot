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

/**
 * GET a detector endpoint, surfacing the backend's `detail` as an ApiError so
 * callers can branch on it (e.g. retention gating). `what` names the resource in
 * the fallback message used when the error body is missing or unparseable.
 */
async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const fallback = `Failed to fetch ${what}: ${res.status}`;
    const body = await res.json().catch(() => ({ detail: fallback }));
    throw new ApiError(res.status, body.detail ?? fallback);
  }
  return res.json() as Promise<T>;
}

function fetchTraceFindings(projectId: string, traceId: string) {
  return getJson<{ findings: BackendFinding[] }>(
    `/api/projects/${projectId}/traces/${traceId}/findings`,
    "trace findings",
  );
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

function fetchRca(projectId: string, findingId: string) {
  return getJson<{ rca: DetectorRca | null }>(
    `/api/projects/${projectId}/findings/${findingId}/rca`,
    "RCA",
  );
}

// Detector findings, runs and RCA are written asynchronously by the worker after
// a trace is ingested, so a trace opened live starts with none of them. These
// queries poll after open — so the Alert button, Detectors tab and RCA answer
// appear without a manual refresh — and stop as soon as what they wait for has
// landed.
//
// The per-trace detection state (useTraceDetectionState) says authoritatively
// when to stop: "sampled_out" means nothing will ever appear, and "pending"
// names exactly the detector runs to expect. The elapsed window is only the
// safety net for when that signal is absent (record expired past its TTL, Redis
// down, trace opened before the claim was written) or an expected run never
// materializes because its job died. It has to comfortably exceed pipeline
// latency — evaluation is debounced until the trace goes quiet (EVALUATOR_DELAY,
// ~60s) and jobs run under a 1-hour Celery visibility timeout with no short cap
// — or polling quits before anything exists and forces the very refresh it
// exists to avoid.
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
 * Shared cadence rule: keep polling while the awaited result is still
 * outstanding, giving up at the window. `settled` is each query's own "nothing
 * more to wait for" test. The interval functions below are pure and exported so
 * those tests are unit-checked without driving a real interval.
 */
function pollUntilSettled(settled: boolean, elapsedMs: number): number | false {
  if (settled) return false;
  return elapsedMs < TRACE_POLL_WINDOW_MS ? TRACE_POLL_INTERVAL_MS : false;
}

/**
 * Findings cadence: settled once a finding exists — the Alert button renders and
 * useRca takes over from there — or once detection is ruled out.
 */
export function findingsPollInterval(
  findingCount: number,
  elapsedMs: number,
  detection?: TraceDetectionState,
): number | false {
  return pollUntilSettled(findingCount > 0 || detectionRuledOut(detection), elapsedMs);
}

/**
 * Detector-runs cadence: a run row is written only when its detector finishes,
 * so there is no in-flight row to watch. Settled once every enqueued detector
 * has a run — the precise completion signal — or once detection is ruled out.
 */
export function detectorRunsPollInterval(
  runCount: number,
  elapsedMs: number,
  detection?: TraceDetectionState,
): number | false {
  const expected = detection?.state === "pending" ? detection.detectorIds.length : 0;
  return pollUntilSettled(
    detectionRuledOut(detection) || (expected > 0 && runCount >= expected),
    elapsedMs,
  );
}

/**
 * Detection-state cadence: "pending" and "sampled_out" are sticky for the
 * record's TTL, so once either is read there is nothing further to learn, and a
 * missing record is not re-read — that would put a standing poll on every
 * historical trace view for a race the results window already covers. Only the
 * transient "deciding" is worth another look.
 */
export function detectionStatePollInterval(state: DetectionStateValue): number | false {
  return state === "deciding" ? TRACE_POLL_INTERVAL_MS : false;
}

/**
 * RCA cadence: polls while the run is in flight, and — bounded by the window —
 * while the row is still absent, because the worker writes the finding first and
 * the DetectorRca row a moment later, so a just-surfaced finding briefly has no
 * row at all. The window also bounds a detector with RCA disabled, which never
 * gets a row.
 */
export function rcaPollInterval(
  status: DetectorRca["status"] | undefined,
  elapsedMs: number,
): number | false {
  if (status === "pending" || status === "running") return TRACE_POLL_INTERVAL_MS;
  return pollUntilSettled(status !== undefined, elapsedMs); // done | failed => settled
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

function fetchRuns(projectId: string, detectorId: string, query: RunsQuery = {}) {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.start_after) params.set("start_after", query.start_after);
  if (query.end_before) params.set("end_before", query.end_before);
  if (query.search_query) params.set("search_query", query.search_query);
  if (query.identified) params.set("identified", "true");

  const qs = params.toString();
  return getJson<RunsResponse>(
    `/api/projects/${projectId}/detectors/${detectorId}/runs${qs ? `?${qs}` : ""}`,
    "runs",
  );
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

function fetchTraceDetectorRuns(projectId: string, traceId: string) {
  return getJson<{ runs: BackendRun[] }>(
    `/api/projects/${projectId}/traces/${traceId}/detector-runs`,
    "trace detector runs",
  );
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
