// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  useTraceFindings,
  findingsPollInterval,
  detectorRunsPollInterval,
  rcaPollInterval,
  detectionStatePollInterval,
  detectionInFlight,
  detectionRuledOut,
  TRACE_POLL_INTERVAL_MS,
  TRACE_POLL_WINDOW_MS,
  type TraceDetectionState,
} from "./use-findings";

// Detector findings and runs are produced asynchronously (and deliberately
// debounced ~1min) after ingestion, so a trace opened live must poll to surface
// the Alert button and Detectors tab without a manual refresh — and must stop
// precisely, driven by the authoritative detection state rather than a timer
// guess. These cases pin down each stop condition.

const PENDING = (ids: string[]): TraceDetectionState => ({ state: "pending", detectorIds: ids });
const SAMPLED_OUT: TraceDetectionState = { state: "sampled_out", detectorIds: [] };
const NO_SIGNAL: TraceDetectionState = { state: null, detectorIds: [] };

describe("findingsPollInterval — trace-page findings poll cadence", () => {
  it("polls at the interval while no finding exists and the window is open", () => {
    expect(findingsPollInterval(0, 0)).toBe(TRACE_POLL_INTERVAL_MS);
    expect(findingsPollInterval(0, TRACE_POLL_WINDOW_MS - 1)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("stops immediately once a finding exists (Alert button + useRca take over)", () => {
    // Even at t=0 with the window wide open, a finding ends polling.
    expect(findingsPollInterval(1, 0)).toBe(false);
    expect(findingsPollInterval(3, 5000)).toBe(false);
  });

  it("does not poll at all when detection is authoritatively ruled out", () => {
    // sampled_out is sticky: no finding will ever appear, so waiting is waste.
    expect(findingsPollInterval(0, 0, SAMPLED_OUT)).toBe(false);
  });

  it("keeps polling through the debounce while detection is pending", () => {
    // The ~60s evaluator debounce must not be mistaken for "nothing coming".
    expect(findingsPollInterval(0, 65_000, PENDING(["d1"]))).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("falls back to the window when there is no authoritative signal", () => {
    expect(findingsPollInterval(0, 0, NO_SIGNAL)).toBe(TRACE_POLL_INTERVAL_MS);
    expect(findingsPollInterval(0, TRACE_POLL_WINDOW_MS, NO_SIGNAL)).toBe(false);
  });

  it("stops once the window elapses so an unflagged trace doesn't poll forever", () => {
    expect(findingsPollInterval(0, TRACE_POLL_WINDOW_MS)).toBe(false);
    expect(findingsPollInterval(0, TRACE_POLL_WINDOW_MS + 10_000)).toBe(false);
  });
});

describe("detectorRunsPollInterval — trace-page detector-runs poll cadence", () => {
  it("polls while the window is open so runs appear as they complete", () => {
    expect(detectorRunsPollInterval(0, 0)).toBe(TRACE_POLL_INTERVAL_MS);
    expect(detectorRunsPollInterval(0, TRACE_POLL_WINDOW_MS - 1)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("stops as soon as every enqueued detector has a run (precise completion)", () => {
    // 3 expected, 3 present → done, regardless of how much window remains.
    expect(detectorRunsPollInterval(3, 0, PENDING(["a", "b", "c"]))).toBe(false);
  });

  it("keeps polling while runs are still missing, even past the window", () => {
    // The authoritative expectation outranks the clock: 1 of 3 landed.
    expect(detectorRunsPollInterval(1, 65_000, PENDING(["a", "b", "c"]))).toBe(
      TRACE_POLL_INTERVAL_MS,
    );
  });

  it("does not poll at all when detection is ruled out", () => {
    expect(detectorRunsPollInterval(0, 0, SAMPLED_OUT)).toBe(false);
  });

  it("stops at the window when an expected run never materializes", () => {
    // Safety net: a dead job must not leave the page polling forever.
    expect(detectorRunsPollInterval(1, TRACE_POLL_WINDOW_MS, PENDING(["a", "b"]))).toBe(false);
  });

  it("stops once the window elapses with no signal", () => {
    expect(detectorRunsPollInterval(0, TRACE_POLL_WINDOW_MS)).toBe(false);
  });
});

describe("detectionStatePollInterval — re-reading the claim record", () => {
  it("re-reads only the transient deciding state", () => {
    expect(detectionStatePollInterval("deciding")).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("stops on sticky states — there is nothing further to learn", () => {
    expect(detectionStatePollInterval("pending")).toBe(false);
    expect(detectionStatePollInterval("sampled_out")).toBe(false);
  });

  it("does not poll a missing record (would add a standing poll to old traces)", () => {
    expect(detectionStatePollInterval(null)).toBe(false);
  });
});

describe("detection state predicates", () => {
  it("treats pending and deciding as in flight — the early working signal", () => {
    expect(detectionInFlight(PENDING(["d1"]))).toBe(true);
    expect(detectionInFlight({ state: "deciding", detectorIds: [] })).toBe(true);
  });

  it("is not in flight for sampled_out, missing signal, or undefined", () => {
    expect(detectionInFlight(SAMPLED_OUT)).toBe(false);
    expect(detectionInFlight(NO_SIGNAL)).toBe(false);
    expect(detectionInFlight(undefined)).toBe(false);
  });

  it("rules out only sampled_out — an absent signal is not a promise of nothing", () => {
    expect(detectionRuledOut(SAMPLED_OUT)).toBe(true);
    expect(detectionRuledOut(NO_SIGNAL)).toBe(false);
    expect(detectionRuledOut(undefined)).toBe(false);
  });
});

describe("rcaPollInterval — RCA poll cadence through the finding→row gap", () => {
  it("polls while the run is in flight (pending/running), regardless of elapsed time", () => {
    expect(rcaPollInterval("pending", 0)).toBe(TRACE_POLL_INTERVAL_MS);
    // Still polling even past the window — an in-flight run isn't abandoned.
    expect(rcaPollInterval("running", TRACE_POLL_WINDOW_MS + 60_000)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("keeps polling when the RCA row doesn't exist yet, within the window", () => {
    // The worker writes the finding first, so a just-surfaced finding briefly
    // has no RCA row at all (status undefined) and must still be waited on.
    expect(rcaPollInterval(undefined, 0)).toBe(TRACE_POLL_INTERVAL_MS);
    expect(rcaPollInterval(undefined, TRACE_POLL_WINDOW_MS - 1)).toBe(TRACE_POLL_INTERVAL_MS);
  });

  it("stops waiting for a row once the window elapses (RCA was disabled → no row)", () => {
    expect(rcaPollInterval(undefined, TRACE_POLL_WINDOW_MS)).toBe(false);
  });

  it("stops on a terminal status", () => {
    expect(rcaPollInterval("done", 0)).toBe(false);
    expect(rcaPollInterval("failed", 0)).toBe(false);
  });
});

/**
 * Renders useTraceFindings against a stubbed backend and returns a live count of
 * findings fetches. Requests are routed by URL because the hook also reads the
 * detection-state record — counting raw fetch calls would conflate the two.
 * `findingsOnCall` returns the findings array for the nth findings fetch.
 */
function renderTraceFindings(
  detectionState: { state: string; detector_ids: string[] },
  findingsOnCall: (call: number) => unknown[],
) {
  const calls = { findings: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/detection-state")) {
        return { ok: true, json: async () => detectionState };
      }
      const call = ++calls.findings;
      return { ok: true, json: async () => ({ findings: findingsOnCall(call) }) };
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderHook(() => useTraceFindings("p1", "t1"), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
  return calls;
}

describe("useTraceFindings — polling is wired to the interval", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps fetching while findings are empty, then stops once one arrives", async () => {
    vi.useFakeTimers();
    // Detection is queued for one detector, so the gate stays open. Empty for the
    // first two polls (the worker hasn't flagged yet), then flagged.
    const calls = renderTraceFindings({ state: "pending", detector_ids: ["d1"] }, (call) =>
      call > 2 ? [{ finding_id: "f1", trace_id: "t1" }] : [],
    );

    // Initial fetch.
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.findings).toBe(1);

    // Two poll ticks: empty, empty → keeps polling.
    await vi.advanceTimersByTimeAsync(TRACE_POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(TRACE_POLL_INTERVAL_MS);
    expect(calls.findings).toBe(3);

    // The third response carried a finding → polling stops; further time is inert.
    await vi.advanceTimersByTimeAsync(TRACE_POLL_INTERVAL_MS * 4);
    expect(calls.findings).toBe(3);
  });

  it("never polls when detection is sampled out (no detector will ever run)", async () => {
    vi.useFakeTimers();
    const calls = renderTraceFindings({ state: "sampled_out", detector_ids: [] }, () => []);

    // One initial read, then nothing — the authoritative "nothing coming".
    await vi.advanceTimersByTimeAsync(TRACE_POLL_INTERVAL_MS * 5);
    expect(calls.findings).toBe(1);
  });
});
