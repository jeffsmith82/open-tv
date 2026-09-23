import { Component, OnInit } from "@angular/core";
import { NgbActiveModal } from "@ng-bootstrap/ng-bootstrap";
import { EPG } from "../models/epg";
import { Channel } from "../models/channel";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "../memory.service";

@Component({
  selector: "app-epg-modal",
  templateUrl: "./epg-modal.component.html",
  styleUrl: "./epg-modal.component.css",
})
export class EpgModalComponent implements OnInit {
  name?: string;
  sourceId?: number;
  channelId?: number;
  // Needed (tv_archive, stream_id, source_id) to check catch-up availability
  // for whichever programme is currently shown, as you navigate - not just
  // the one that was first clicked to open this modal - and to fetch this
  // channel's own full schedule below.
  channel?: Channel;
  // start_timestamp of the programme that was clicked to open this modal -
  // used to locate it within the freshly-fetched schedule below, since the
  // caller only ever holds a narrow window around the current pan position,
  // not the full schedule (see epg-timeline.component.ts's this.epgs).
  initialStartTimestamp?: number;
  epg: EPG[] = [];
  // Index of the programme currently shown within epg (its full schedule,
  // in chronological order) - prev/next step through adjacent programmes
  // one at a time, rather than jumping a whole calendar day.
  currentIndex = 0;
  private catchupChecked = new Set<number>();

  constructor(
    public activeModal: NgbActiveModal,
    private memory: MemoryService,
  ) { }

  ngOnInit() {
    invoke("get_epg_ids").then((x) => {
      let set = new Set(x as Array<string>);
      this.memory.Watched_epgs = set;
    });
    this.loadSchedule();
  }

  // Fetches this one channel's whole retained schedule (up to
  // epg_retention_days back, several days forward) so prev/next can step
  // all the way through it - only done once, here, rather than by every
  // timeline row just to draw its 4-hour bar.
  private async loadSchedule() {
    try {
      this.epg = await invoke("get_epg_schedule", { channel: this.channel });
    } catch {
      this.epg = [];
    }
    this.currentIndex = Math.max(
      0,
      this.epg.findIndex((e) => e.start_timestamp === this.initialStartTimestamp),
    );
    this.checkCatchupForCurrent();
  }

  get current(): EPG | undefined {
    return this.epg[this.currentIndex];
  }

  hasPrev(): boolean {
    return this.currentIndex > 0;
  }

  hasNext(): boolean {
    return this.currentIndex < this.epg.length - 1;
  }

  prev() {
    if (this.hasPrev()) {
      this.currentIndex--;
      this.checkCatchupForCurrent();
    }
  }

  next() {
    if (this.hasNext()) {
      this.currentIndex++;
      this.checkCatchupForCurrent();
    }
  }

  // Bulk-fetched EPG data never carries catch-up info (only an on-demand,
  // per-programme check does - see epg-timeline.component.ts's original
  // click handler, whose logic this mirrors so browsing via prev/next gets
  // the same treatment as the programme you actually clicked).
  private async checkCatchupForCurrent() {
    const index = this.currentIndex;
    const epg = this.epg[index];
    if (!epg || epg.has_archive || this.catchupChecked.has(index)) return;
    this.catchupChecked.add(index);
    const canHaveCatchup = this.channel?.tv_archive === true && epg.start_timestamp < Date.now() / 1000;
    if (!canHaveCatchup) return;
    try {
      epg.timeshift_url = await invoke("build_timeshift_url", {
        channel: this.channel,
        startTimestamp: epg.start_timestamp,
        endTimestamp: epg.end_timestamp,
      });
      epg.has_archive = true;
    } catch {
      // provider rejected it (e.g. outside its own catch-up window) -
      // leave has_archive unset so no timeshift button is offered
    }
  }

  getFormattedDate() {
    const date = this.current ? new Date(this.current.start_timestamp * 1000) : new Date();
    return date
      .toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
      })
      .replace(",", "");
  }
}
