import { expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { cleanZones, fillHoles } from "../modules/zones";
import { saveWorldProperties, WorldSaveError, type World } from "../modules/worldstore";

const square = (x: number, y: number, size: number) => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];
const generated = [
  { id: 0, name: "Wind Fields", kind: "grassland", levels: [1, 10], start: true, bbox: { x: 10, y: 10, w: 20, h: 20 }, hub: "Ashfield", outline: [square(10, 10, 20)] },
  { id: 1, name: "Red Barrens", kind: "desert", bbox: { x: 40, y: 40, w: 10, h: 10 }, outline: [square(40, 40, 10)] },
];

// A world as the store holds it, with only a manifest on disk (saving properties touches nothing else)
function world(): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zones-world-"));
  const manifest = { id: "test", width: 100, height: 100, worldRev: 3, nextObjectId: 1, layers: [], objects: [], zones: structuredClone(generated) };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const stat = fs.statSync(path.join(dir, "manifest.json"));
  return {
    id: "test", name: "test.json", dir, manifest, checksum: "", width: 100, height: 100, chunkSize: 64, chunksX: 2, chunksY: 2,
    packChunks: 1, tileLayerCount: 0, layers: [], fileHashes: {} as any, packTables: new Map(),
    manifestStamp: { size: stat.size, mtimeMs: stat.mtimeMs } as any,
  } as World;
}
const onDisk = (w: World) => JSON.parse(fs.readFileSync(path.join(w.dir, "manifest.json"), "utf-8"));

test("the asset server's copy of the zone rules works out a zone's bounds", () => {
  const result = cleanZones([{ name: "Town", outline: [[[10, 10], [20, 10], [20, 30]]] }], 100, 100);
  expect(result).toEqual({ zones: [{ name: "Town", bbox: { x: 10, y: 10, w: 10, h: 20 }, outline: [[[10, 10], [20, 10], [20, 30]]] }] });
});

test("saving a world's zones replaces manifest.zones and keeps a generated zone's own keys", () => {
  const w = world();
  saveWorldProperties(w, undefined, undefined, [{ ...generated[0], music: "Wind Theme" }, { name: "Town", outline: [square(60, 60, 5)] }]);
  const zones = onDisk(w).zones;
  expect(zones.map((z: any) => z.name)).toEqual(["Wind Fields", "Town"]);
  expect(zones[0]).toMatchObject({ id: 0, levels: [1, 10], hub: "Ashfield", start: true, music: "wind theme" });
  expect(zones[1].bbox).toEqual({ x: 60, y: 60, w: 5, h: 5 });
  expect(onDisk(w).worldRev).toBe(4);
});

test("a save without zones leaves the generated zones as they are", () => {
  const w = world();
  saveWorldProperties(w, [], undefined);
  expect(onDisk(w).zones).toEqual(generated);
});

test("an empty zone list removes every zone", () => {
  const w = world();
  saveWorldProperties(w, undefined, undefined, []);
  expect(onDisk(w).zones).toEqual([]);
});

test("a bad zone refuses the save and leaves the manifest alone", () => {
  const w = world();
  expect(() => saveWorldProperties(w, undefined, undefined, [{ name: "Town", outline: [[[0, 0], [1, 1]]] }])).toThrow(WorldSaveError);
  expect(onDisk(w).zones).toEqual(generated);
});

test("the asset server's copy of the zone rules fills a zone's holes", () => {
  expect(fillHoles([square(15, 15, 3), square(10, 10, 20), square(40, 40, 5)])).toEqual([square(10, 10, 20), square(40, 40, 5)]);
  const result = cleanZones([{ name: "Town", outline: [square(10, 10, 20), square(15, 15, 3)] }], 100, 100);
  expect("zones" in result && result.zones[0]!.outline).toEqual([square(10, 10, 20)]);
});
