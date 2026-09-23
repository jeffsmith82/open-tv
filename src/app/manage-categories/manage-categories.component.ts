import { Component, HostListener } from "@angular/core";
import { Router } from "@angular/router";
import { invoke } from "@tauri-apps/api/core";
import { MemoryService } from "../memory.service";
import { Source } from "../models/source";
import { Group } from "../models/group";
import { Channel } from "../models/channel";
import { MediaType } from "../models/mediaType";
import { RailItem } from "../models/railItem";
import { isInputFocused } from "../utils";

interface DisplayGroup {
  group: Group;
  // Stable position within the current visible row order (selected
  // playlist + expanded types + filter) - used for shift+click range-select
  // math, independent of which section a row visually falls under.
  index: number;
}

interface TypeSection {
  mediaType: number;
  label: string;
  rows: DisplayGroup[];
  totalCount: number;
}

interface DisplayChannel {
  channel: Channel;
  index: number;
}

const TYPE_ORDER = [MediaType.livestream, MediaType.movie, MediaType.serie];
// Piggybacks on the same expandedTypes/isExpanded/toggleType mechanism the
// three category sections use, just under a key none of MediaType's real
// values can collide with, so "Individual Channels" gets identical
// collapse/expand + auto-expand-on-filter behavior for free.
const INDIVIDUAL_CHANNELS_SECTION = -1;

@Component({
  selector: "app-manage-categories",
  templateUrl: "./manage-categories.component.html",
  styleUrl: "./manage-categories.component.css",
})
export class ManageCategoriesComponent {
  readonly railItemEnum = RailItem;
  loading = false;
  filterText = "";
  sources: Source[] = [];
  allGroups: Group[] = [];
  selectedSourceId?: number;
  sections: TypeSection[] = [];
  private flatRows: DisplayGroup[] = [];
  private expandedTypes = new Set<number>();
  selectedIds = new Set<number>();
  private lastClickedIndex: number | null = null;

  readonly individualChannelsSection = INDIVIDUAL_CHANNELS_SECTION;
  hiddenChannelRows: DisplayChannel[] = [];
  selectedChannelIds = new Set<number>();
  private hiddenChannels: Channel[] = [];
  private lastClickedChannelIndex: number | null = null;

  constructor(
    private router: Router,
    public memory: MemoryService,
  ) {}

  async ngOnInit() {
    this.loading = true;
    const [sources, groups] = await Promise.all([
      invoke("get_sources"),
      invoke("get_all_groups"),
    ]);
    // Disabled sources aren't browsable anywhere else in the app, so their
    // categories shouldn't be manageable here either.
    this.sources = (sources as Source[]).filter((s) => s.enabled);
    this.allGroups = groups as Group[];
    this.selectedSourceId = this.sources[0]?.id;
    this.rebuildRows();
    await this.loadHiddenChannels();
    this.loading = false;
  }

  @HostListener("document:keydown", ["$event"])
  onKeyDown(event: KeyboardEvent) {
    if (
      event.key == "Escape" ||
      event.key == "BrowserBack" ||
      (event.key == "Backspace" && !isInputFocused())
    ) {
      event.preventDefault();
      this.goBack();
    }
  }

  goBack() {
    this.router.navigateByUrl("");
  }

  selectRail(item: RailItem) {
    if (item === RailItem.ManageCategories) return;
    if (item === RailItem.Settings) {
      this.router.navigateByUrl("settings");
      return;
    }
    this.router.navigate([""], { queryParams: { rail: item } });
  }

  private mediaTypeLabel(mediaType: number): string {
    switch (mediaType) {
      case MediaType.livestream:
        return "Channels";
      case MediaType.movie:
        return "Movies";
      case MediaType.serie:
        return "Series";
      default:
        return "Other";
    }
  }

  async onSourceChange() {
    // Selection is scoped to what's currently visible - switching playlists
    // clears it rather than silently carrying hidden, invisible selections
    // across to a different playlist's "Hide selected"/"Unhide selected".
    this.selectedIds.clear();
    this.lastClickedIndex = null;
    this.selectedChannelIds.clear();
    this.lastClickedChannelIndex = null;
    this.rebuildRows();
    await this.loadHiddenChannels();
  }

  onFilterChange() {
    this.rebuildRows();
    this.lastClickedIndex = null;
    this.rebuildChannelRows();
    this.lastClickedChannelIndex = null;
  }

  // A section is expanded either because the user opened it, or because an
  // active filter should still surface matches inside a collapsed section
  // rather than hiding them.
  isExpanded(mediaType: number): boolean {
    return this.filterText.trim() !== "" || this.expandedTypes.has(mediaType);
  }

  toggleType(mediaType: number) {
    if (this.expandedTypes.has(mediaType)) this.expandedTypes.delete(mediaType);
    else this.expandedTypes.add(mediaType);
  }

  private rebuildRows() {
    const text = this.filterText.trim().toLowerCase();
    const groupsForSource = this.allGroups.filter((g) => g.source_id === this.selectedSourceId);
    const sections: TypeSection[] = [];
    const flatRows: DisplayGroup[] = [];
    let index = 0;
    for (const mediaType of TYPE_ORDER) {
      const groupsOfType = groupsForSource.filter((g) => g.media_type === mediaType);
      const filtered = text
        ? groupsOfType.filter((g) => g.name?.toLowerCase().includes(text))
        : groupsOfType;
      const rows: DisplayGroup[] = filtered.map((group) => ({ group, index: index++ }));
      flatRows.push(...rows);
      sections.push({
        mediaType,
        label: this.mediaTypeLabel(mediaType),
        rows,
        totalCount: groupsOfType.length,
      });
    }
    this.sections = sections;
    this.flatRows = flatRows;
  }

  isSelected(group: Group): boolean {
    return group.id != undefined && this.selectedIds.has(group.id);
  }

  onRowClick(row: DisplayGroup, event: MouseEvent) {
    const checked = (event.target as HTMLInputElement).checked;
    if (event.shiftKey && this.lastClickedIndex !== null) {
      const start = Math.min(this.lastClickedIndex, row.index);
      const end = Math.max(this.lastClickedIndex, row.index);
      for (const r of this.flatRows) {
        if (r.index >= start && r.index <= end && r.group.id != undefined) {
          if (checked) this.selectedIds.add(r.group.id);
          else this.selectedIds.delete(r.group.id);
        }
      }
    } else if (row.group.id != undefined) {
      if (checked) this.selectedIds.add(row.group.id);
      else this.selectedIds.delete(row.group.id);
    }
    this.lastClickedIndex = row.index;
  }

  async hideSelected() {
    await this.setHiddenForSelected(true);
  }

  async unhideSelected() {
    await this.setHiddenForSelected(false);
  }

  private async setHiddenForSelected(hidden: boolean) {
    if (this.selectedIds.size === 0) return;
    const ids = Array.from(this.selectedIds);
    const verb = hidden ? "Hid" : "Unhid";
    await this.memory.tryIPC(
      `${verb} ${ids.length} categor${ids.length === 1 ? "y" : "ies"} successfully`,
      "Failed to update categories",
      async () => {
        await invoke("set_groups_hidden", { ids, hidden });
        for (const group of this.allGroups) {
          if (group.id != undefined && this.selectedIds.has(group.id)) group.hidden = hidden;
        }
      },
    );
    this.selectedIds.clear();
    this.lastClickedIndex = null;
  }

  private async loadHiddenChannels() {
    if (this.selectedSourceId == undefined) {
      this.hiddenChannels = [];
      this.rebuildChannelRows();
      return;
    }
    this.hiddenChannels = await invoke("get_hidden_channels", { sourceId: this.selectedSourceId });
    this.rebuildChannelRows();
  }

  private rebuildChannelRows() {
    const text = this.filterText.trim().toLowerCase();
    const filtered = text
      ? this.hiddenChannels.filter((c) => c.name?.toLowerCase().includes(text))
      : this.hiddenChannels;
    this.hiddenChannelRows = filtered.map((channel, index) => ({ channel, index }));
  }

  isChannelSelected(channel: Channel): boolean {
    return channel.id != undefined && this.selectedChannelIds.has(channel.id);
  }

  onChannelRowClick(row: DisplayChannel, event: MouseEvent) {
    const checked = (event.target as HTMLInputElement).checked;
    if (event.shiftKey && this.lastClickedChannelIndex !== null) {
      const start = Math.min(this.lastClickedChannelIndex, row.index);
      const end = Math.max(this.lastClickedChannelIndex, row.index);
      for (const r of this.hiddenChannelRows) {
        if (r.index >= start && r.index <= end && r.channel.id != undefined) {
          if (checked) this.selectedChannelIds.add(r.channel.id);
          else this.selectedChannelIds.delete(r.channel.id);
        }
      }
    } else if (row.channel.id != undefined) {
      if (checked) this.selectedChannelIds.add(row.channel.id);
      else this.selectedChannelIds.delete(row.channel.id);
    }
    this.lastClickedChannelIndex = row.index;
  }

  // Unhide-only - unlike categories, this section only ever lists channels
  // that are already hidden, so there's nothing to "hide" from here (that's
  // still done via the normal right-click menu on a visible channel tile).
  async unhideSelectedChannels() {
    if (this.selectedChannelIds.size === 0) return;
    const ids = Array.from(this.selectedChannelIds);
    await this.memory.tryIPC(
      `Unhid ${ids.length} channel${ids.length === 1 ? "" : "s"} successfully`,
      "Failed to unhide channels",
      async () => {
        await invoke("set_channels_hidden", { ids, hidden: false });
        this.hiddenChannels = this.hiddenChannels.filter(
          (c) => c.id == undefined || !this.selectedChannelIds.has(c.id),
        );
        this.rebuildChannelRows();
      },
    );
    this.selectedChannelIds.clear();
    this.lastClickedChannelIndex = null;
  }
}
