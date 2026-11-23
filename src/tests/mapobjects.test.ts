import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { cleanStoneObjects, saveWorldProperties, stoneProperties, WorldSaveError, type World } from "../modules/worldstore";

const warp = { name: "to-town", map: "town", x: 5, y: 6, position: { x: 64, y: 96 }, size: { width: 32, height: 32 } };
const chest = { name: "c1", lootTableId: 4, resetMinutes: 30, position: { x: 96, y: 128 }, layer: null };
const portal = { name: "p1", dungeonId: 2, position: { x: 160, y: 192 }, size: { width: 64, height: 48 }, layer: null };

function world(): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mapobjects-world-"));
  const manifest = { id: "test", width: 100, height: 100, worldRev: 1, nextObjectId: 1, layers: [], objects: [] };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  const stat = fs.statSync(path.join(dir, "manifest.json"));
  return {
    id: "test", name: "test.json", dir, manifest, checksum: "", width: 100, height: 100, chunkSize: 64, chunksX: 2, chunksY: 2,
    packChunks: 1, tileLayerCount: 0, layers: [], fileHashes: {} as any, packTables: new Map(),
    manifestStamp: { size: stat.size, mtimeMs: stat.mtimeMs } as any,
  } as World;
}
const onDisk = (w: World) => JSON.parse(fs.readFileSync(path.join(w.dir, "manifest.json"), "utf-8"));
const inLayer = (w: World, layer: string) => onDisk(w).objects.filter((o: any) => o.layer === layer);
const prop = (o: any, name: string) => o.properties.find((p: any) => p.name === name)?.value;

test("saving chests and dungeon portals writes their layers with the properties the engine reads", () => {
  const w = world();
  saveWorldProperties(w, undefined, undefined, undefined, [chest], [portal]);
  const chests = inLayer(w, "Chests");
  expect(chests).toHaveLength(1);
  expect(chests[0]).toMatchObject({ name: "c1", type: "chest", x: 96, y: 128 });
  expect(prop(chests[0], "loot_table")).toBe(4);
  expect(prop(chests[0], "reset_minutes")).toBe(30);
  const portals = inLayer(w, "Dungeon Portals");
  expect(portals).toHaveLength(1);
  expect(portals[0]).toMatchObject({ name: "p1", type: "dungeon_portal", x: 160, y: 192, width: 64, height: 48 });
  expect(prop(portals[0], "dungeon")).toBe(2);
  expect(prop(portals[0], "kind")).toBe("dungeon");
  expect(prop(portals[0], "mirror")).toBe(true);
  expect(onDisk(w).layers.map((l: any) => l.name)).toEqual(["Chests", "Dungeon Portals"]);
});

test("a teleport portal keeps its place and Mirror other side; a portal linked to no dungeon has no dungeon property", () => {
  const w = world();
  const teleport = { ...portal, name: "t1", kind: "teleport", dungeonId: null, mirror: false, target: { map: "town", x: 100, y: 200 } };
  const unlinked = { ...portal, name: "u1", dungeonId: null };
  saveWorldProperties(w, undefined, undefined, undefined, undefined, [teleport, unlinked]);
  const [t, u] = inLayer(w, "Dungeon Portals");
  expect([prop(t, "kind"), prop(t, "mirror"), prop(t, "map"), prop(t, "x"), prop(t, "y"), prop(t, "dungeon")]).toEqual(["teleport", false, "town", 100, 200, undefined]);
  expect([prop(u, "kind"), prop(u, "mirror"), prop(u, "dungeon")]).toEqual(["dungeon", true, undefined]);
});

test("a return portal (a teleport's way back or a dungeon's exit) keeps the link to its source as return_of_map and return_of; other portals have none", () => {
  const w = world();
  const teleport = { ...portal, name: "t1", kind: "teleport", dungeonId: null, target: { map: "town", x: 100, y: 200 } };
  const ret = { ...teleport, name: "t1 (return)", returnOf: { map: "town", name: "Gate" } };
  const exit = { ...portal, name: "DungeonPortal_1 (return)", dungeonId: null, returnOf: { map: "overworld.json", name: "DungeonPortal_1" } };
  saveWorldProperties(w, undefined, undefined, undefined, undefined, [teleport, ret, portal, exit]);
  const [t, r, d, e] = inLayer(w, "Dungeon Portals");
  expect([prop(r, "kind"), prop(r, "map"), prop(r, "return_of_map"), prop(r, "return_of")]).toEqual(["teleport", "town", "town", "Gate"]);
  expect([prop(e, "kind"), prop(e, "dungeon"), prop(e, "return_of_map"), prop(e, "return_of")]).toEqual(["dungeon", undefined, "overworld", "DungeonPortal_1"]);
  expect([prop(t, "return_of_map"), prop(t, "return_of")]).toEqual([undefined, undefined]);
  expect([prop(d, "return_of_map"), prop(d, "return_of")]).toEqual([undefined, undefined]);
});

test("saving chests leaves the warps alone, and an undefined list leaves its layer alone", () => {
  const w = world();
  saveWorldProperties(w, undefined, [warp]);
  const warpsBefore = inLayer(w, "Warps");
  saveWorldProperties(w, undefined, undefined, undefined, [chest], [portal]);
  expect(inLayer(w, "Warps")).toEqual(warpsBefore);
  saveWorldProperties(w, undefined, undefined, undefined, [{ ...chest, name: "c2" }]);
  expect(inLayer(w, "Chests").map((o: any) => o.name)).toEqual(["c2"]);
  expect(inLayer(w, "Dungeon Portals").map((o: any) => o.name)).toEqual(["p1"]);
  saveWorldProperties(w, undefined, undefined, undefined, [], []);
  expect(inLayer(w, "Chests")).toEqual([]);
  expect(inLayer(w, "Dungeon Portals")).toEqual([]);
});

test("an object keeps its id across saves", () => {
  const w = world();
  saveWorldProperties(w, undefined, undefined, undefined, [chest]);
  const id = inLayer(w, "Chests")[0].id;
  saveWorldProperties(w, undefined, undefined, undefined, [{ ...chest, resetMinutes: 60 }]);
  expect(inLayer(w, "Chests")[0].id).toBe(id);
  expect(prop(inLayer(w, "Chests")[0], "reset_minutes")).toBe(60);
});

test("a bad chest or portal refuses the save and leaves the manifest alone", () => {
  const w = world();
  saveWorldProperties(w, undefined, undefined, undefined, [chest], [portal]);
  const before = onDisk(w);
  const bad = [
    () => saveWorldProperties(w, undefined, undefined, undefined, [{ ...chest, lootTableId: 0 }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, [{ ...chest, resetMinutes: 0 }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, [{ ...chest, resetMinutes: 1441 }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, [{ ...chest, position: { x: "a", y: 1 } }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, undefined, [{ ...portal, dungeonId: 0 }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, undefined, [{ ...portal, size: { width: 0, height: 10 } }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, undefined, [{ ...portal, kind: "door" }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, undefined, [{ ...portal, kind: "teleport", target: null }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, undefined, [{ ...portal, kind: "teleport", target: { map: "", x: 1, y: 1 } }]),
    () => saveWorldProperties(w, undefined, undefined, undefined, "nope" as any),
  ];
  for (const fn of bad) expect(fn).toThrow(WorldSaveError);
  expect(onDisk(w)).toEqual(before);
});

describe("summoning stones", () => {
  const stone = { name: "S", position: { x: 5, y: 6 }, glowColor: "#66CCFF", layer: null };

  test("cleanStoneObjects keeps name, foot and lower-cased glow colour", () => {
    expect(cleanStoneObjects([stone])).toEqual([{ name: "S", glowColor: "#66ccff", x: 5, y: 6 }]);
  });

  test("cleanStoneObjects refuses a stone without a position or with a bad colour", () => {
    expect(() => cleanStoneObjects([{ name: "S", glowColor: "#66ccff" }])).toThrow("has no position");
    expect(() => cleanStoneObjects([{ ...stone, glowColor: "blue" }])).toThrow("#rrggbb");
    expect(() => cleanStoneObjects("nope")).toThrow("summoning stones must be a list");
  });

  test("stoneProperties is what the engine reads", () => {
    expect(stoneProperties({ name: "S", glowColor: "#66ccff", x: 5, y: 6 })).toEqual([{ name: "glow_color", type: "string", value: "#66ccff" }]);
  });

  test("saving stones writes the Summoning Stones layer as points, and leaving them out keeps them", () => {
    const w = world();
    saveWorldProperties(w, undefined, undefined, undefined, undefined, undefined, [stone]);
    const stones = inLayer(w, "Summoning Stones");
    expect(stones).toHaveLength(1);
    expect(stones[0]).toMatchObject({ name: "S", type: "summoning_stone", x: 5, y: 6, width: 0, height: 0, point: true });
    expect(prop(stones[0], "glow_color")).toBe("#66ccff");
    saveWorldProperties(w, undefined, undefined, undefined, [chest]);
    expect(inLayer(w, "Summoning Stones")).toEqual(stones);
    const before = onDisk(w);
    expect(() => saveWorldProperties(w, undefined, undefined, undefined, undefined, undefined, [{ ...stone, glowColor: "#12" }])).toThrow(WorldSaveError);
    expect(onDisk(w)).toEqual(before);
  });
});
