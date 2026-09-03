import { LoadShape, type LoadShapeData } from "./loadShape.ts";
import { RequestComposition, type RequestCompositionData } from "./requestComposition.ts";

export interface LoadData {
  id: string;
  startSeconds: number;
  durationSeconds: number;
  shape: LoadShapeData;
  requests: RequestCompositionData;
}

/** One scheduled occurrence placed on a Track — a LoadShape (its request-rate curve) paired with
 *  a RequestComposition (what it actually sends). */
export class Load {
  id: string;
  startSeconds: number;
  durationSeconds: number;
  shape: LoadShape;
  requests: RequestComposition;

  constructor(params: {
    id: string;
    startSeconds: number;
    durationSeconds: number;
    shape: LoadShape;
    requests: RequestComposition;
  }) {
    this.id = params.id;
    this.startSeconds = params.startSeconds;
    this.durationSeconds = params.durationSeconds;
    this.shape = params.shape;
    this.requests = params.requests;
  }

  toJSON(): LoadData {
    return {
      id: this.id,
      startSeconds: this.startSeconds,
      durationSeconds: this.durationSeconds,
      shape: this.shape.toJSON(),
      requests: this.requests.toJSON(),
    };
  }

  static fromJSON(data: LoadData): Load {
    return new Load({
      id: data.id,
      startSeconds: data.startSeconds,
      durationSeconds: data.durationSeconds,
      shape: LoadShape.fromJSON(data.shape),
      requests: RequestComposition.fromJSON(data.requests),
    });
  }

  /** Immutable update — returns a new Load with `patch` applied. Plain object-spread
   *  (`{...load, x}`) would silently drop this class's prototype (and any nested class fields
   *  not explicitly re-specified), so callers should always go through this instead. */
  with(patch: Partial<{ startSeconds: number; durationSeconds: number; shape: LoadShape; requests: RequestComposition }>): Load {
    return new Load({
      id: this.id,
      startSeconds: patch.startSeconds ?? this.startSeconds,
      durationSeconds: patch.durationSeconds ?? this.durationSeconds,
      shape: patch.shape ?? this.shape,
      requests: patch.requests ?? this.requests,
    });
  }
}

export interface TrackData {
  id: string;
  label: string;
  color?: string;
  loads: LoadData[];
}

/** One lane on the timeline — a named, user-organized grouping of Loads. Not tied to a single
 *  LoadShapeKind: a Track is just organizational, each Load carries its own shape. */
export class Track {
  id: string;
  label: string;
  /** Hex color string (e.g. "#3b82f6") assigned by the user via the color picker. Undefined means
   *  the timeline will fall back to the palette-derived default for the track's position. */
  color: string | undefined;
  loads: Load[];

  constructor(params: { id: string; label: string; color?: string; loads: Load[] }) {
    this.id = params.id;
    this.label = params.label;
    this.color = params.color;
    this.loads = params.loads;
  }

  toJSON(): TrackData {
    // `color` is emitted next to `label`, before the (long) loads array, so it stays visible in
    // the Compose Code view — a one-line property serialized after hundreds of lines of loads is
    // effectively hidden from the person editing the document.
    return {
      id: this.id,
      label: this.label,
      ...(this.color !== undefined ? { color: this.color } : {}),
      loads: this.loads.map((load) => load.toJSON()),
    };
  }

  static fromJSON(data: TrackData): Track {
    return new Track({ id: data.id, label: data.label, color: data.color, loads: data.loads.map(Load.fromJSON) });
  }

  with(patch: Partial<{ label: string; color: string | undefined; loads: Load[] }>): Track {
    return new Track({
      id: this.id,
      label: patch.label ?? this.label,
      color: "color" in patch ? patch.color : this.color,
      loads: patch.loads ?? this.loads,
    });
  }
}

export interface LoadTimelineData {
  totalDurationSeconds: number;
  tracks: TrackData[];
}

export class LoadTimeline {
  totalDurationSeconds: number;
  tracks: Track[];

  constructor(params: { totalDurationSeconds: number; tracks: Track[] }) {
    this.totalDurationSeconds = params.totalDurationSeconds;
    this.tracks = params.tracks;
  }

  toJSON(): LoadTimelineData {
    return { totalDurationSeconds: this.totalDurationSeconds, tracks: this.tracks.map((track) => track.toJSON()) };
  }

  static fromJSON(data: LoadTimelineData): LoadTimeline {
    return new LoadTimeline({ totalDurationSeconds: data.totalDurationSeconds, tracks: data.tracks.map(Track.fromJSON) });
  }

  static empty(): LoadTimeline {
    return new LoadTimeline({ totalDurationSeconds: 600, tracks: [] });
  }

  with(patch: Partial<{ totalDurationSeconds: number; tracks: Track[] }>): LoadTimeline {
    return new LoadTimeline({
      totalDurationSeconds: patch.totalDurationSeconds ?? this.totalDurationSeconds,
      tracks: patch.tracks ?? this.tracks,
    });
  }
}
