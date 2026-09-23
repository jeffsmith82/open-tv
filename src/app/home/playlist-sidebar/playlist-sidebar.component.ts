import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
} from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { MatMenuTrigger } from "@angular/material/menu";
import { MemoryService } from "../../memory.service";
import { ErrorService } from "../../error.service";
import { Channel } from "../../models/channel";
import { Source } from "../../models/source";
import { MediaType } from "../../models/mediaType";
import { ViewMode } from "../../models/viewMode";
import { NodeType } from "../../models/nodeType";
import { SortType } from "../../models/sortType";

const MIN_WIDTH_PX = 216; // 13.5rem
const MAX_WIDTH_PX = 416; // 26rem
const PAGE_SIZE = 36; // must match src-tauri/src/sql.rs PAGE_SIZE

@Component({
  selector: "app-playlist-sidebar",
  templateUrl: "./playlist-sidebar.component.html",
  styleUrl: "./playlist-sidebar.component.css",
})
export class PlaylistSidebarComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  @Input() mediaType?: MediaType;
  @Input() selectedSourceIds?: number[];
  @Input() selectedGroupId?: number;
  @Output() sourceSelect = new EventEmitter<number[] | undefined>();
  @Output() widthChange = new EventEmitter<number>();

  expanded = new Set<number>();
  categoriesBySource = new Map<number, Channel[]>();
  loadingSource = new Set<number>();
  collapsed = false;
  resizing = false;
  manualWidthPx?: number;

  private resizeObserver?: ResizeObserver;
  private dragStartX = 0;
  private dragStartWidth = 0;
  private readonly onDragMove = (event: MouseEvent) => this.handleDragMove(event);
  private readonly onDragEnd = () => this.handleDragEnd();

  toggleCollapsed() {
    this.collapsed = !this.collapsed;
    this.manualWidthPx = undefined;
  }

  startResize(event: MouseEvent) {
    if (this.collapsed) return;
    event.preventDefault();
    this.resizing = true;
    this.dragStartX = event.clientX;
    this.dragStartWidth = this.el.nativeElement.querySelector(".playlist-sidebar")!.clientWidth;
    document.addEventListener("mousemove", this.onDragMove);
    document.addEventListener("mouseup", this.onDragEnd);
  }

  private handleDragMove(event: MouseEvent) {
    const delta = event.clientX - this.dragStartX;
    this.manualWidthPx = Math.min(MAX_WIDTH_PX, Math.max(MIN_WIDTH_PX, this.dragStartWidth + delta));
  }

  private handleDragEnd() {
    this.resizing = false;
    document.removeEventListener("mousemove", this.onDragMove);
    document.removeEventListener("mouseup", this.onDragEnd);
  }

  constructor(
    public memory: MemoryService,
    private error: ErrorService,
    private el: ElementRef,
  ) { }

  ngAfterViewInit(): void {
    const element = this.el.nativeElement.querySelector(".playlist-sidebar");
    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width != undefined) this.widthChange.emit(width);
    });
    this.resizeObserver.observe(element);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.handleDragEnd();
  }

  ngOnInit(): void {
    this.expandAllSources();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["mediaType"]) {
      // categories are media-type specific, so a stale cache would show the wrong list
      this.expanded.clear();
      this.categoriesBySource.clear();
      if (!changes["mediaType"].firstChange) this.expandAllSources();
    }
  }

  private expandAllSources(): void {
    for (const source of this.sources) {
      this.expanded.add(source.id!);
      this.loadCategories(source);
    }
  }

  get sources(): Source[] {
    return Array.from(this.memory.Sources.values());
  }

  isAllSourcesSelected(): boolean {
    return !this.selectedSourceIds || this.selectedSourceIds.length !== 1;
  }

  isSourceSelected(source: Source): boolean {
    return !!this.selectedSourceIds && this.selectedSourceIds.length === 1 && this.selectedSourceIds[0] === source.id;
  }

  selectAllSources() {
    this.sourceSelect.emit(Array.from(this.memory.Sources.keys()));
  }

  selectSource(source: Source) {
    this.sourceSelect.emit([source.id!]);
  }

  async toggleExpand(source: Source, event: Event) {
    event.stopPropagation();
    if (this.expanded.has(source.id!)) {
      this.expanded.delete(source.id!);
      return;
    }
    this.expanded.add(source.id!);
    if (!this.categoriesBySource.has(source.id!)) {
      await this.loadCategories(source);
    }
  }

  private async loadCategories(source: Source) {
    this.loadingSource.add(source.id!);
    try {
      let allGroups: Channel[] = [];
      let page = 1;
      while (true) {
        let groups: Channel[] = await invoke("search", {
          filters: {
            source_ids: [source.id!],
            media_types: this.mediaType != undefined ? [this.mediaType] : [],
            view_type: ViewMode.Categories,
            page: page,
            use_keywords: false,
            sort: SortType.provider,
          },
        });
        allGroups = allGroups.concat(groups);
        if (groups.length < PAGE_SIZE) break;
        page++;
      }
      this.categoriesBySource.set(source.id!, allGroups);
    } catch (e) {
      this.error.handleError(e);
    } finally {
      this.loadingSource.delete(source.id!);
    }
  }

  selectCategory(group: Channel) {
    this.memory.SetNode.next({
      id: group.id!,
      name: group.name!,
      type: NodeType.Category,
      sourceId: group.source_id,
      // This sidebar's own category list is always fetched scoped to one
      // media type (see loadCategories() above) - carrying it along lets
      // the main view align its own media_types filter to match, instead
      // of leaving whatever was selected from earlier browsing, which
      // could silently filter out everything in this category.
      mediaType: this.mediaType,
    });
  }

  isCategorySelected(group: Channel): boolean {
    return this.selectedGroupId == group.id;
  }

  // One shared trigger/menu for the whole category tree (mirroring
  // ChannelTileComponent's per-tile context menu pattern, just at the list
  // level since this component renders many rows, not one).
  @ViewChild(MatMenuTrigger, { static: true }) matMenuTrigger!: MatMenuTrigger;
  menuTopLeftPosition = { x: 0, y: 0 };
  contextMenuGroup?: Channel;

  onCategoryRightClick(event: MouseEvent, group: Channel) {
    event.preventDefault();
    this.contextMenuGroup = group;
    this.menuTopLeftPosition.x = event.clientX;
    this.menuTopLeftPosition.y = event.clientY;
    if (this.memory.currentContextMenu?.menuOpen) this.memory.currentContextMenu.closeMenu();
    this.memory.currentContextMenu = this.matMenuTrigger;
    this.matMenuTrigger.openMenu();
  }

  async hideCategory() {
    const group = this.contextMenuGroup;
    if (!group) return;
    try {
      await invoke("hide_group", { id: group.id, hidden: true });
      const list = this.categoriesBySource.get(group.source_id!);
      if (list) this.categoriesBySource.set(group.source_id!, list.filter((g) => g.id !== group.id));
    } catch (e) {
      this.error.handleError(e);
    }
  }
}
