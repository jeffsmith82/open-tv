import { Component, EventEmitter, Input, Output } from "@angular/core";
import { RailItem } from "../../models/railItem";

@Component({
  selector: "app-nav-rail",
  templateUrl: "./nav-rail.component.html",
  styleUrl: "./nav-rail.component.css",
})
export class NavRailComponent {
  readonly railItemEnum = RailItem;
  @Input() active: RailItem = RailItem.Channels;
  @Output() select = new EventEmitter<RailItem>();

  items = [
    { item: RailItem.Favourites, label: "Favourites" },
    { item: RailItem.Channels, label: "Channels" },
    { item: RailItem.Movies, label: "Movies" },
    { item: RailItem.Series, label: "Series" },
    { item: RailItem.History, label: "History" },
    { item: RailItem.ManageCategories, label: "Manage Categories" },
  ];

  click(item: RailItem) {
    this.select.emit(item);
  }
}
