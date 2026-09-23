import { Component, OnDestroy, OnInit } from "@angular/core";
import { Subscription, interval } from "rxjs";
import {
  EPG_TIMELINE_DURATION_SECONDS,
  epgTimelinePercentFor,
  epgTimelineWindowStart,
} from "../../models/epgTimelineWindow";
import { MemoryService } from "../../memory.service";

const TICK_INTERVAL_SECONDS = 30 * 60;
// Slight overlap with the previous window (window is 4h wide) so paging
// through the day keeps some context instead of jumping to a totally
// disconnected span.
const PAN_STEP_SECONDS = 3 * 60 * 60;

@Component({
  selector: "app-epg-timeline-header",
  templateUrl: "./epg-timeline-header.component.html",
  styleUrl: "./epg-timeline-header.component.css",
})
export class EpgTimelineHeaderComponent implements OnInit, OnDestroy {
  now = Date.now() / 1000;
  offsetSeconds = 0;
  // Cached once per tick rather than reading Date.now() directly inside
  // nowPercent()/showNowLine() - the template calls nowPercent() from two
  // separate bindings ([style.left.%] and the *ngIf via showNowLine()) in
  // the same change-detection pass, and two independent Date.now() reads
  // milliseconds apart returned different values, which Angular's dev-mode
  // checkNoChanges pass flags as NG0100.
  private trueNow = Date.now() / 1000;
  private tickSubscription?: Subscription;
  private offsetSubscription?: Subscription;

  constructor(private memory: MemoryService) { }

  ngOnInit(): void {
    this.tickSubscription = interval(30000).subscribe(() => this.updateNow());
    this.offsetSubscription = this.memory.EpgTimelineOffsetSeconds.subscribe((offset) => {
      this.offsetSeconds = offset;
      this.updateNow();
    });
  }

  ngOnDestroy(): void {
    this.tickSubscription?.unsubscribe();
    this.offsetSubscription?.unsubscribe();
  }

  private updateNow(): void {
    this.trueNow = Date.now() / 1000;
    this.now = this.trueNow + this.offsetSeconds;
  }

  panBack(): void {
    this.memory.EpgTimelineOffsetSeconds.next(this.offsetSeconds - PAN_STEP_SECONDS);
  }

  panForward(): void {
    this.memory.EpgTimelineOffsetSeconds.next(this.offsetSeconds + PAN_STEP_SECONDS);
  }

  resetToNow(): void {
    this.memory.EpgTimelineOffsetSeconds.next(0);
  }

  ticks(): number[] {
    const start = epgTimelineWindowStart(this.now);
    const end = start + EPG_TIMELINE_DURATION_SECONDS;
    const ticks: number[] = [];
    for (
      let t = Math.ceil(start / TICK_INTERVAL_SECONDS) * TICK_INTERVAL_SECONDS;
      t <= end;
      t += TICK_INTERVAL_SECONDS
    ) {
      ticks.push(t);
    }
    return ticks;
  }

  tickPercent(timestamp: number): number {
    return epgTimelinePercentFor(timestamp, this.now);
  }

  tickLabel(timestamp: number): string {
    return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  nowPercent(): number {
    return epgTimelinePercentFor(this.trueNow, this.now);
  }

  showNowLine(): boolean {
    const percent = this.nowPercent();
    return percent >= 0 && percent <= 100;
  }
}
