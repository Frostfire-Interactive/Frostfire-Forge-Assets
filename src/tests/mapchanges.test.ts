import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { MapChangeLog, mapEventStream, mapSyncStatePath, readMapSyncState, startMapChanges, writeMapSyncState, type MapSyncState } from "../modules/mapchanges";

const map = (name: string, checksum: string) => ({ name, checksum, data: { name, checksum } });

describe("the list of changed maps", () => {
  test("after a restart, holds only the maps that differ from the last run, for a game server that was up to date", () => {
    const saved: MapSyncState[] = [];
    const before = new MapChangeLog(256, "run", (s) => saved.push(s));
    before.start([map("a.json", "1"), map("b.json", "1"), map("c.json", "1")], null);
    before.record(map("b.json", "2"));
    const place = before.place();

    // b and c were changed on disk (an upload) while the asset server was down; d is new; a is the same
    const after = new MapChangeLog(256, "other", () => {});
    const listed = after.start([map("a.json", "1"), map("b.json", "3"), map("c.json", "9"), map("d.json", "1")], saved.at(-1));
    expect(listed).toBe(3);
    const answer = after.since(place.epoch, place.seq);
    expect(answer.full).toBe(false);
    expect(answer.maps.map((m) => m.name).sort()).toEqual(["b.json", "c.json", "d.json"]);
    expect(answer.epoch).toBe("run");
  });

  test("after a restart, answers full for a game server that had not taken in every change of the last run", () => {
    const saved: MapSyncState[] = [];
    const before = new MapChangeLog(256, "run", (s) => saved.push(s));
    before.start([map("a.json", "1")], null);
    const behind = before.place();
    before.record(map("a.json", "2"));
    const after = new MapChangeLog(256, "other", () => {});
    after.start([map("a.json", "2")], saved.at(-1));
    expect(after.since(behind.epoch, behind.seq).full).toBe(true);
    // the one that had it is told nothing
    const ahead = { epoch: "run", seq: behind.seq + 1 };
    expect(after.since(ahead.epoch, ahead.seq)).toMatchObject({ full: false, maps: [] });
  });

  test("without a state from the last run starts a new run: every game server compares once", () => {
    const log = new MapChangeLog(256, "fresh", () => {});
    expect(log.start([map("a.json", "1")], null)).toBe(0);
    expect(log.since("old", 4).full).toBe(true);
    const broken = new MapChangeLog(256, "fresh2", () => {});
    broken.start([map("a.json", "1")], { epoch: 5, seq: "x" });
    expect(broken.place().epoch).toBe("fresh2");
  });

  test("saves its state at start and at every change, before anyone is told", () => {
    const order: string[] = [];
    const log = new MapChangeLog(256, "run", (s) => order.push(`save ${s.seq} ${s.checksums["a.json"]}`));
    log.start([map("a.json", "1")], null);
    log.subscribe((event) => order.push(`told ${"seq" in event ? event.seq : "worlds"}`));
    log.record(map("a.json", "2"));
    expect(order).toEqual(["save 0 1", "save 1 2", "told 1"]);
  });

  test("is not ready before start", () => {
    const log = new MapChangeLog(256, "run", () => {});
    expect(log.ready).toBe(false);
    log.start([], null);
    expect(log.ready).toBe(true);
  });

  test("tells every listener each saved map, with the place before it, until it leaves", () => {
    const log = new MapChangeLog(256, "run", () => {});
    log.start([map("a.json", "1")], null);
    const heard: unknown[] = [];
    const leave = log.subscribe((event) => heard.push(event));
    log.record(map("a.json", "2"));
    log.worldsChanged();
    leave();
    log.record(map("a.json", "3"));
    expect(heard).toEqual([
      { epoch: "run", from: 0, seq: 1, maps: [{ name: "a.json", checksum: "2", data: { name: "a.json", checksum: "2" } }] },
      { worlds: true },
    ]);
  });

  test("a listener that throws does not stop the others", () => {
    const log = new MapChangeLog(256, "run", () => {});
    log.start([], null);
    const heard: number[] = [];
    log.subscribe(() => { throw new Error("gone"); });
    log.subscribe(() => heard.push(1));
    log.record(map("a.json", "2"));
    expect(heard).toEqual([1]);
  });
});

describe("the stream a game server follows", () => {
  async function lines(reader: { read(): Promise<{ value?: Uint8Array; done?: boolean }> }, count: number): Promise<string[]> {
    const decoder = new TextDecoder();
    let text = "";
    while (text.split("\n").length - 1 < count) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return text.split("\n").slice(0, count);
  }

  test("starts with the changes since the place, then each change as it is made, and stops at cancel", async () => {
    const log = new MapChangeLog(256, "run", () => {});
    log.start([map("a.json", "1")], null);
    log.record(map("a.json", "2"));
    const reader = mapEventStream(log, "run", 0, 60000).getReader();
    log.record(map("b.json", "1"));
    log.worldsChanged();
    const [first, second, third] = await lines(reader, 3);
    expect(JSON.parse(first!)).toMatchObject({ success: true, epoch: "run", seq: 1, full: false, maps: [{ name: "a.json", checksum: "2" }] });
    expect(JSON.parse(second!)).toMatchObject({ epoch: "run", from: 1, seq: 2, maps: [{ name: "b.json" }] });
    expect(JSON.parse(third!)).toEqual({ worlds: true });
    await reader.cancel();
    const told: unknown[] = [];
    log.subscribe((e) => told.push(e));
    log.record(map("c.json", "1"));
    expect(told.length).toBe(1); // only the new listener: the stream's left at cancel
  });

  test("sends an empty line every heartbeat", async () => {
    const log = new MapChangeLog(256, "run", () => {});
    log.start([], null);
    const reader = mapEventStream(log, "other", 0, 10).getReader();
    const [first, beat] = await lines(reader, 2);
    expect(JSON.parse(first!).full).toBe(true);
    expect(beat).toBe("");
    await reader.cancel();
  });
});

test("the state is written beside the maps, read back, and a missing or broken file reads as none", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "map-sync-"));
  try {
    const file = mapSyncStatePath(dir);
    expect(file.endsWith(".json")).toBe(false); // the map loaders read every .json file in the folder
    expect(readMapSyncState(file)).toBeNull();
    writeMapSyncState(file, { epoch: "run", seq: 3, checksums: { "a.json": "1" } });
    expect(readMapSyncState(file)).toEqual({ epoch: "run", seq: 3, checksums: { "a.json": "1" } });
    fs.writeFileSync(file, "{nope");
    expect(readMapSyncState(file)).toBeNull();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the state is kept in MAP_SYNC_STATE_FILE when set, for a maps folder that cannot be written", () => {
  const maps = fs.mkdtempSync(path.join(os.tmpdir(), "map-sync-maps-"));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "map-sync-state-"));
  const before = process.env.MAP_SYNC_STATE_FILE;
  try {
    const file = path.join(elsewhere, "state");
    process.env.MAP_SYNC_STATE_FILE = file;
    startMapChanges(maps, [{ name: "a.json", checksum: "1", data: {} }]);
    expect((readMapSyncState(file) as MapSyncState).checksums).toEqual({ "a.json": "1" });
    expect(fs.existsSync(mapSyncStatePath(maps))).toBe(false);
  } finally {
    if (before === undefined) delete process.env.MAP_SYNC_STATE_FILE;
    else process.env.MAP_SYNC_STATE_FILE = before;
    fs.rmSync(maps, { recursive: true, force: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});
