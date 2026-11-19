// The startup worker pool: the maps are made ready and their world map images baked on several threads at once
// (mapload.worker.ts). The pool lives only while the assets load at start.
import os from "os";
import type { MapLoadJob, MapLoadResult } from "./mapload.worker";

type Job = MapLoadJob extends infer J ? J extends any ? Omit<J, "id"> : never : never;

export class MapLoadPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: { job: MapLoadJob; resolve: (r: MapLoadResult) => void }[] = [];
  private waiting = new Map<number, (r: MapLoadResult) => void>();
  private nextId = 1;

  constructor(size = Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1))) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL("./mapload.worker.ts", import.meta.url).href);
      worker.onmessage = (event: MessageEvent<MapLoadResult>) => {
        const resolve = this.waiting.get(event.data.id);
        this.waiting.delete(event.data.id);
        this.idle.push(worker);
        this.pump();
        resolve?.(event.data);
      };
      worker.onerror = (event: ErrorEvent) => {
        // a worker that died: fail what it held, and go on with the others
        for (const [id, resolve] of this.waiting) {
          if ((worker as any).__job === id) { this.waiting.delete(id); resolve({ id, ok: false, error: event.message || "the worker stopped" }); }
        }
        this.workers = this.workers.filter(w => w !== worker);
        if (this.workers.length === 0) for (const q of this.queue.splice(0)) q.resolve({ id: q.job.id, ok: false, error: "no map worker is running" });
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  run(job: Job): Promise<MapLoadResult> {
    return new Promise(resolve => {
      this.queue.push({ job: { ...job, id: this.nextId++ } as MapLoadJob, resolve });
      this.pump();
    });
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop()!;
      if (!this.workers.includes(worker)) continue;
      const { job, resolve } = this.queue.shift()!;
      this.waiting.set(job.id, resolve);
      (worker as any).__job = job.id;
      worker.postMessage(job);
    }
  }

  close(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers = [];
    this.idle = [];
  }
}

export const toBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
