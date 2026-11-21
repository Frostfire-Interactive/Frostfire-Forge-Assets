import crypto from "crypto";
import fs from "fs";
import path from "path";
import log from "./logger";

/** A map as saved here, sent to a game server that does not hold it yet. */
export type ChangedMap = { name: string; checksum: string; data: unknown };

/** What is kept of the list between runs: its run, its last number, and each map's checksum. */
export type MapSyncState = { epoch: string; seq: number; checksums: Record<string, string> };

export type MapEvent = { epoch: string; from: number; seq: number; maps: ChangedMap[] } | { worlds: true };

const isState = (value: any): value is MapSyncState =>
  !!value && typeof value.epoch === "string" && value.epoch.length > 0 && Number.isInteger(value.seq) && value.seq >= 0
  && !!value.checksums && typeof value.checksums === "object";

export class MapChangeLog {
  private seq = 0;
  private dropped = 0;
  private readonly changed = new Map<string, ChangedMap & { seq: number }>();
  private readonly checksums = new Map<string, string>();
  private readonly listeners = new Set<(event: MapEvent) => void>();
  /** False until start: the maps are not read yet, and no answer can be given. */
  ready = false;

  constructor(
    private readonly limit = 256,
    private epoch: string = crypto.randomUUID(),
    private readonly save: (state: MapSyncState) => void = () => {},
  ) {}

  start(maps: ChangedMap[], kept: unknown): number {
    let listed = 0;
    if (isState(kept)) {
      this.epoch = kept.epoch;
      this.seq = kept.seq;
      this.dropped = kept.seq;
      for (const map of maps) {
        if (kept.checksums[map.name] === map.checksum) continue;
        this.add(map);
        listed++;
      }
    }
    this.checksums.clear();
    for (const map of maps) this.checksums.set(map.name, map.checksum);
    this.save(this.state());
    this.ready = true;
    return listed;
  }

  record(map: ChangedMap): void {
    this.add(map);
    this.checksums.set(map.name, map.checksum);
    // Saved before anyone is told: a number a game server holds is never one a restart could give again
    this.save(this.state());
    this.tell({ epoch: this.epoch, from: this.seq - 1, seq: this.seq, maps: [{ name: map.name, checksum: map.checksum, data: map.data }] });
  }

  /** A world was saved or made here: game servers read the list of worlds again. */
  worldsChanged(): void {
    this.tell({ worlds: true });
  }

  /** Calls the listener with each change from now on; returns the function that stops it. */
  subscribe(listener: (event: MapEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  place(): { epoch: string; seq: number } {
    return { epoch: this.epoch, seq: this.seq };
  }

  state(): MapSyncState {
    return { epoch: this.epoch, seq: this.seq, checksums: Object.fromEntries(this.checksums) };
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

  private add(map: ChangedMap): void {
    this.seq++;
    this.changed.delete(map.name);
    this.changed.set(map.name, { name: map.name, checksum: map.checksum, data: map.data, seq: this.seq });
    while (this.changed.size > this.limit) {
      const [name, oldest] = this.changed.entries().next().value!;
      this.dropped = oldest.seq;
      this.changed.delete(name);
    }
  }

  private tell(event: MapEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a game server that left meanwhile: its stream is closed by its own end
      }
    }
  }
}

export function mapEventStream(log: MapChangeLog, epoch: unknown, since: unknown, heartbeatMs = 5000): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let leave = () => {};
  let beat: ReturnType<typeof setInterval> | null = null;
  const stop = () => {
    leave();
    if (beat) clearInterval(beat);
    beat = null;
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          stop();
        }
      };
      send(`${JSON.stringify({ success: true, ...log.since(epoch, since) })}\n`);
      leave = log.subscribe((event) => send(`${JSON.stringify(event)}\n`));
      beat = setInterval(() => send("\n"), heartbeatMs);
    },
    cancel() {
      stop();
    },
  });
}

/** Where the state of the list is kept between runs: beside the maps, under a name no map loader reads. */
export const mapSyncStatePath = (mapDir: string) => path.join(mapDir, ".map-sync-state");

export function readMapSyncState(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function writeMapSyncState(file: string, state: MapSyncState): void {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  fs.renameSync(`${file}.tmp`, file);
}

let stateFile = "";
const mapChanges = new MapChangeLog(256, crypto.randomUUID(), (state) => {
  if (!stateFile) return;
  try {
    writeMapSyncState(stateFile, state);
  } catch (error: any) {
    // Without it the next run starts a new list, and every game server compares every map once
    log.warn(`[AssetServer] The map sync state could not be saved to ${stateFile}: ${error?.message ?? error}`);
  }
});

export function startMapChanges(mapDir: string, maps: ChangedMap[]): number {
  stateFile = process.env.MAP_SYNC_STATE_FILE || mapSyncStatePath(mapDir);
  return mapChanges.start(maps, readMapSyncState(stateFile));
}

export default mapChanges;
