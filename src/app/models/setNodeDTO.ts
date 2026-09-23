import { MediaType } from "./mediaType";
import { NodeType } from "./nodeType";

export class SetNodeDTO {
  public id: number;
  public name: string;
  public type: NodeType;
  public sourceId?: number;
  // Only set for NodeType.Category, coming from the playlist sidebar's own
  // rail-scoped mediaType - see home.component.ts's SetNode subscription
  // for why this needs to override filters.media_types.
  public mediaType?: MediaType;

  constructor(
    id: number,
    name: string,
    type: NodeType,
    sourceId?: number,
    mediaType?: MediaType,
  ) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.sourceId = sourceId;
    this.mediaType = mediaType;
  }
}
