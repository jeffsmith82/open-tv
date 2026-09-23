// Shared by EpgTimelineComponent (per-row programme blocks) and
// EpgTimelineHeaderComponent (the time ruler): every row uses this same
// fixed window, so blocks/ticks land at the same horizontal position in
// every row without any scroll-sync JS.
export const EPG_TIMELINE_LEAD_SECONDS = 30 * 60;
export const EPG_TIMELINE_DURATION_SECONDS = 4 * 60 * 60;

// How much data EpgTimelineComponent asks the backend for around wherever
// the timeline is currently panned to - wide enough to cover several pan
// clicks (PAN_STEP_SECONDS = 3h in epg-timeline-header.component.ts)
// without a refetch, but far short of the full retention window, which
// only the EPG modal's prev/next paging actually needs (see
// get_epg_schedule).
export const EPG_FETCH_LOOKBACK_SECONDS = 24 * 60 * 60;
export const EPG_FETCH_LOOKAHEAD_SECONDS = 24 * 60 * 60;

export function epgTimelineWindowStart(nowSeconds: number): number {
  return nowSeconds - EPG_TIMELINE_LEAD_SECONDS;
}

export function epgTimelinePercentFor(timestampSeconds: number, nowSeconds: number): number {
  return (
    ((timestampSeconds - epgTimelineWindowStart(nowSeconds)) / EPG_TIMELINE_DURATION_SECONDS) * 100
  );
}
