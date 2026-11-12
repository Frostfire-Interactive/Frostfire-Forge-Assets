import crypto from "crypto";

/** A map as saved here, sent to a game server that does not hold it yet. */
export type ChangedMap = { name: string; checksum: string; data: unknown };

/**
 * The maps saved here since this run started (/update-map, /save-map-chunks, /save-map-properties, a map made in the
 * map editor), each with the number of the save that changed it last. A game server asks for the maps changed since
 * the last number it was told (/map-changes) and takes in only those. A place from another run (the files may have
 * changed while the asset server was down), or from before the oldest change still held, is answered with `full`:
 * the game server then compares every map once (/map-checksums), and that answer gives it its new place.
 */
export class MapChangeLog {
  private seq = 0;
  private dropped = 0;
  private readonly changed = new Map<string, ChangedMap & { seq: number }>();

  constructor(private readonly limit = 256, private readonly epoch: string = crypto.randomUUID()) {}

  record(map: ChangedMap): void {
    this.seq++;
    this.changed.delete(map.name);
    this.changed.set(map.name, { name: map.name, checksum: map.checksum, data: map.data, seq: this.seq });
    while (this.changed.size > this.limit) {
      const [name, oldest] = this.changed.entries().next().value!;
      this.dropped = oldest.seq;
      this.changed.delete(name);
    }
  }

  place(): { epoch: string; seq: number } {
    return { epoch: this.epoch, seq: this.seq };
  }

  since(epoch: unknown, since: unknown): { epoch: string; seq: number; full: boolean; maps: ChangedMap[] } {
    const answer = { epoch: this.epoch, seq: this.seq, full: true, maps: [] as ChangedMap[] };
    if (epoch !== this.epoch || typeof since !== "number" || !Number.isInteger(since) || since < this.dropped || since > this.seq) return answer;
    answer.full = false;
    for (const entry of this.changed.values()) {
      if (entry.seq > since) answer.maps.push({ name: entry.name, checksum: entry.checksum, data: entry.data });
    }
    return answer;
  }
}

const mapChanges = new MapChangeLog();
export default mapChanges;
