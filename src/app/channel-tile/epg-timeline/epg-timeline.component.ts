import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
} from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { NgbModal } from "@ng-bootstrap/ng-bootstrap";
import { Subject, Subscription, debounceTime, interval } from "rxjs";
import { Channel } from "../../models/channel";
import { EPG } from "../../models/epg";
import {
  epgTimelinePercentFor,
  EPG_FETCH_LOOKAHEAD_SECONDS,
  EPG_FETCH_LOOKBACK_SECONDS,
} from "../../models/epgTimelineWindow";
import { MemoryService } from "../../memory.service";
import { EpgModalComponent } from "../../epg-modal/epg-modal.component";

@Component({
  selector: "app-epg-timeline",
  templateUrl: "./epg-timeline.component.html",
  styleUrl: "./epg-timeline.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EpgTimelineComponent implements AfterViewInit, OnChanges, OnDestroy {
  @Input() channel?: Channel;

  epgs: EPG[] = [];
  fetched = false;
  // The window all blocks/the now-line position against - real time plus
  // the shared pan offset, so every row moves together when you page
  // forward/backward via the timeline header.
  now = Date.now() / 1000;

  // Cached once per tick rather than reading Date.now() directly inside
  // nowPercent()/showNowLine()/isNowPlaying() - calling Date.now() fresh
  // from two separate template bindings in the same change-detection pass
  // can return different values milliseconds apart, which Angular's
  // dev-mode checkNoChanges pass flags as NG0100.
  private trueNow = Date.now() / 1000;
  private offsetSeconds = 0;
  private observer?: IntersectionObserver;
  private tickSubscription?: Subscription;
  private offsetSubscription?: Subscription;
  private recycleSubscription?: Subscription;
  // Virtual scroll can recycle this row through many channels in a single
  // fast scroll - fetching (an IPC round-trip + full block re-render) on
  // every one of those intermediate swaps was the main source of the CPU
  // spike reported while scrolling quickly, since almost all of that work
  // is thrown away the instant the row recycles again. Debouncing means
  // only the channel the row actually settles on triggers a fetch.
  private recycled$ = new Subject<void>();
  private viewInitialized = false;

  constructor(
    private el: ElementRef,
    private modal: NgbModal,
    private memory: MemoryService,
    private cdr: ChangeDetectorRef,
  ) { }

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    this.tickSubscription = interval(60000).subscribe(() => this.updateNow());
    this.offsetSubscription = this.memory.EpgTimelineOffsetSeconds.subscribe((offset) => {
      this.offsetSeconds = offset;
      this.updateNow();
      // Only already-fetched (i.e. visible) rows need to follow a pan -
      // an off-screen row will pick up the current offset whenever its
      // own IntersectionObserver eventually fires the first fetch.
      if (this.fetched) {
        this.fetchEpg();
      }
    });
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        this.fetchEpg();
        this.observer?.disconnect();
        this.observer = undefined;
      }
    });
    this.observer.observe(this.el.nativeElement);
    this.recycleSubscription = this.recycled$.pipe(debounceTime(150)).subscribe(() => this.fetchEpg());
  }

  ngOnChanges(changes: SimpleChanges): void {
    // Virtual scroll recycles this component instance for a different row's
    // channel as you scroll - the initial fetch (above) is handled by the
    // IntersectionObserver, but a recycled instance never gets a fresh
    // ngAfterViewInit, so without this a recycled row keeps whatever epgs
    // fetchEpg() last put there.
    //
    // Deliberately does NOT touch epgs/fetched here - it used to clear both
    // immediately on every recycle, but during a fast scroll a row can
    // recycle through many channels before settling, and clearing on each
    // one blanked the tile repeatedly ("loads then unloads") while also
    // doing that clear-triggered render at full recycle frequency, not just
    // on settle. Left alone, the previous channel's blocks just stay up
    // until the debounced fetch below actually resolves and replaces them
    // in one clean swap - stale for a moment rather than blank.
    if (!changes["channel"] || changes["channel"].firstChange || !this.viewInitialized) return;
    this.observer?.disconnect();
    this.observer = undefined;
    this.recycled$.next();
  }

  // Only fetches a window around the current (possibly panned) position,
  // not the channel's whole retained schedule - see get_epg_schedule for
  // the full-range fetch, done once by the modal instead.
  private async fetchEpg() {
    // Captured so a slow response can't clobber the display if this row
    // recycles to yet another channel before this request resolves.
    const requestedChannel = this.channel;
    let result: EPG[];
    try {
      result = await invoke("get_epg", {
        channel: this.channel,
        startTimestamp: Math.floor(this.now - EPG_FETCH_LOOKBACK_SECONDS),
        endTimestamp: Math.floor(this.now + EPG_FETCH_LOOKAHEAD_SECONDS),
      });
    } catch {
      result = [];
    }
    if (this.channel !== requestedChannel) return;
    this.epgs = result;
    this.fetched = true;
    // Resolves from an IPC promise, not a template-bound event - needs an
    // explicit nudge under OnPush (see updateNow()).
    this.cdr.markForCheck();
  }

  private updateNow(): void {
    this.trueNow = Date.now() / 1000;
    this.now = this.trueNow + this.offsetSeconds;
    // Runs from a timer/subscription, not a template-bound event - under
    // OnPush (both this component and its ChannelTileComponent parent),
    // that needs an explicit nudge or the now-line/now-playing highlight
    // would just silently stop updating.
    this.cdr.markForCheck();
  }

  // Positions the true current time within the (possibly panned) window,
  // rather than always sitting at a fixed spot - only actually falls
  // inside the visible [0, 100] range when the window hasn't been panned
  // away from live.
  nowPercent(): number {
    return epgTimelinePercentFor(this.trueNow, this.now);
  }

  showNowLine(): boolean {
    const percent = this.nowPercent();
    return percent >= 0 && percent <= 100;
  }

  // epg.now_playing is a snapshot computed by the backend at fetch time -
  // a tile can stay mounted (and its EPG unfetched again) for a long time,
  // so relying on that flag directly leaves the highlight stuck on whatever
  // was airing back then. Recomputed against the true current time (not
  // the panned window) so "now playing" always means exactly that,
  // regardless of what part of the timeline is currently in view.
  isNowPlaying(epg: EPG): boolean {
    return epg.start_timestamp <= this.trueNow && epg.end_timestamp > this.trueNow;
  }

  // Clamped to the visible [0, 100] range rather than the raw start/end
  // percent, so a programme that started well before the window (an
  // overnight movie, a long-running placeholder block, etc.) still renders
  // - and its title stays visible - instead of sitting off-screen to the
  // left with only its unlabeled tail end inside the container.
  leftPercent(epg: EPG): number {
    return Math.max(0, epgTimelinePercentFor(epg.start_timestamp, this.now));
  }

  widthPercent(epg: EPG): number {
    const left = this.leftPercent(epg);
    const right = Math.min(100, epgTimelinePercentFor(epg.end_timestamp, this.now));
    return Math.max(0, right - left);
  }

  tooltip(epg: EPG): string {
    return `${epg.title} (${epg.start_time} - ${epg.end_time})`;
  }

  // Normal EPG display comes from bulk-fetched data, which never carries
  // catch-up info - checking it is on-demand, per programme, handled by
  // EpgModalComponent itself (so it applies whichever programme is
  // currently shown as you browse via prev/next, not just the one clicked
  // to open this modal).
  onProgrammeClick(epg: EPG, event: MouseEvent) {
    event.stopPropagation();
    this.memory.ModalRef = this.modal.open(EpgModalComponent, {
      backdrop: "static",
      size: "xl",
      keyboard: false,
    });
    this.memory.ModalRef.result.then((_) => (this.memory.ModalRef = undefined));
    const instance = this.memory.ModalRef.componentInstance;
    // The modal fetches the channel's whole retained schedule itself (see
    // get_epg_schedule) so its prev/next buttons can step through adjacent
    // programmes - this component's own this.epgs is only ever a narrow
    // window around the current pan position, not the full schedule.
    instance.channel = this.channel;
    instance.initialStartTimestamp = epg.start_timestamp;
    instance.name = this.channel?.name;
    instance.channelId = this.channel?.id;
    instance.sourceId = this.channel?.source_id;
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
    this.tickSubscription?.unsubscribe();
    this.offsetSubscription?.unsubscribe();
    this.recycleSubscription?.unsubscribe();
  }
}
