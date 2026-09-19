/**
 * Reads captured request/response exchanges back out of the file k6 writes them to.
 *
 * During a run k6 appends one line per request to `exchanges.log` in the run's archive folder
 * (`--console-output`, see `K6Adapter.start()`): `KAIGARA_EXCHANGE <exchange id> <json>` wrapped
 * in k6's JSON log line. Nothing reads that file while the load is running unless the Run screen's
 * popup asks for an exchange — then `ExchangeLogIndex` scans whatever has been appended since its
 * last scan, remembering each line's byte offset, and reads just the one line it needs.
 *
 * The index holds one number per request — an offset, in an array per request type indexed by
 * iteration number (exchange ids are `<script key>:<iteration>`, and iterations are dense) — and
 * never a body, so it stays small even for a run whose bodies were kept complete.
 *
 * The same scan also picks up each exchange's `requestTruncated`/`responseTruncated` flags, for the
 * request log's truncation badge (`RunRequestSample`). That works only because `scriptTemplates.ts`
 * places those two booleans right after the exchange id in the emitted JSON, ahead of the
 * (potentially `CAPTURE_CAP`-sized) body strings — so they always land inside the small header
 * window (`HEADER_BYTES`) this index already reads to find the id, and reading them costs nothing
 * beyond what indexing already does.
 */

import { open } from "node:fs/promises";

import type { RunExchange } from "@kaigara/shared-types";

import { EXCHANGE_LOG_PREFIX } from "./scriptTemplates.ts";

/** Archive-folder file k6's `--console-output` writes the exchanges to. */
export const EXCHANGES_FILE = "exchanges.log";

const CHUNK_BYTES = 1 << 20;
/** How far into a line its exchange id, and now its truncation flags, can be: k6's JSON wrapper
 *  puts the message second, right after `{"level":"info",`, and the flags follow shortly after the
 *  id (see the module doc comment). Comfortably covers both even once JSON string-escaping doubles
 *  every quote. */
const HEADER_BYTES = 384;

/** Whether an exchange line's request/response body was cut, read straight out of the header bytes
 *  already scanned for its offset — never a full parse. `undefined` if either flag is not present
 *  in that window (an older line predating this field, or one somehow reordered). Backslash-strips
 *  first so it matches both a bare line and one wrapped in k6's own JSON log format (which escapes
 *  the embedded quotes). */
function extractTruncation(header: string): { requestTruncated: boolean; responseTruncated: boolean } | undefined {
  const flat = header.replace(/\\/g, "");
  const request = /"requestTruncated"\s*:\s*(true|false)/.exec(flat);
  const response = /"responseTruncated"\s*:\s*(true|false)/.exec(flat);
  if (!request || !response) return undefined;
  return { requestTruncated: request[1] === "true", responseTruncated: response[1] === "true" };
}

function splitExchangeId(id: string): { script: string; iteration: number } | null {
  const colon = id.lastIndexOf(":");
  const iteration = Number(id.slice(colon + 1));
  if (colon <= 0 || !Number.isInteger(iteration) || iteration < 0) return null;
  return { script: id.slice(0, colon), iteration };
}

/** One line back into a `RunExchange`, or `null` if it is not a well-formed exchange line. Accepts
 *  both k6's JSON log wrapper and a bare message line. */
export function parseExchangeLine(line: string): RunExchange | null {
  let message = line;
  try {
    const wrapped = JSON.parse(line) as { msg?: unknown };
    if (typeof wrapped.msg === "string") message = wrapped.msg;
  } catch {
    // Not wrapped — k6 run with a non-JSON log format.
  }
  if (!message.startsWith(EXCHANGE_LOG_PREFIX)) return null;
  const rest = message.slice(EXCHANGE_LOG_PREFIX.length);
  const space = rest.indexOf(" ");
  if (space <= 0) return null;
  try {
    return { id: rest.slice(0, space), ...(JSON.parse(rest.slice(space + 1)) as Omit<RunExchange, "id">) };
  } catch {
    return null;
  }
}

export class ExchangeLogIndex {
  private readonly offsets = new Map<string, number[]>();
  private readonly truncation = new Map<string, ({ requestTruncated: boolean; responseTruncated: boolean } | undefined)[]>();
  /** Byte offset just past the last *complete* line indexed — a line k6 is still writing is left
   *  for the next scan. */
  private scannedTo = 0;
  private scanning: Promise<void> = Promise.resolve();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async find(exchangeId: string): Promise<RunExchange | null> {
    const key = splitExchangeId(exchangeId);
    if (!key) return null;
    let offset = this.offsets.get(key.script)?.[key.iteration];
    if (offset === undefined) {
      // Scans are chained, never concurrent: two overlapping ones would index the same bytes twice.
      this.scanning = this.scanning
        .then(() => this.scan())
        .catch((error) => console.warn(`exchange log: could not index ${this.path}: ${(error as Error).message}`));
      await this.scanning;
      offset = this.offsets.get(key.script)?.[key.iteration];
    }
    if (offset === undefined) return null;
    const line = await this.readLineAt(offset);
    const exchange = line === null ? null : parseExchangeLine(line);
    return exchange?.id === exchangeId ? exchange : null;
  }

  /** Truncation flags for one exchange, from the header bytes already scanned — `undefined` if
   *  this id has not been indexed yet (call `ensureScanned()` first) or carries none. */
  truncationFor(exchangeId: string): { requestTruncated: boolean; responseTruncated: boolean } | undefined {
    const key = splitExchangeId(exchangeId);
    if (!key) return undefined;
    return this.truncation.get(key.script)?.[key.iteration];
  }

  /** Indexes everything appended so far, the bulk equivalent of what `find()` does lazily for one
   *  id — used to annotate a whole request log's truncation badges cheaply (header bytes only,
   *  never a body) before any row has actually been opened. */
  async ensureScanned(): Promise<void> {
    this.scanning = this.scanning
      .then(() => this.scan())
      .catch((error) => console.warn(`exchange log: could not index ${this.path}: ${(error as Error).message}`));
    await this.scanning;
  }

  private record(header: string, offset: number): void {
    const at = header.indexOf(EXCHANGE_LOG_PREFIX);
    if (at === -1) return;
    const start = at + EXCHANGE_LOG_PREFIX.length;
    const end = header.indexOf(" ", start);
    const key = splitExchangeId(header.slice(start, end === -1 ? undefined : end));
    if (!key) return;
    let list = this.offsets.get(key.script);
    if (!list) this.offsets.set(key.script, (list = []));
    list[key.iteration] = offset;

    let truncations = this.truncation.get(key.script);
    if (!truncations) this.truncation.set(key.script, (truncations = []));
    truncations[key.iteration] = extractTruncation(header);
  }

  private async scan(): Promise<void> {
    let handle;
    try {
      handle = await open(this.path, "r");
    } catch {
      return; // Nothing written yet — or a run that never captured anything.
    }
    try {
      const buffer = Buffer.alloc(CHUNK_BYTES);
      let position = this.scannedTo;
      let lineStart = position;
      let header: Buffer[] = [];
      let headerLength = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
        if (bytesRead === 0) break;
        const chunk = buffer.subarray(0, bytesRead);
        let from = 0;
        while (from < chunk.length) {
          const newline = chunk.indexOf(0x0a, from);
          const end = newline === -1 ? chunk.length : newline;
          if (headerLength < HEADER_BYTES) {
            const piece = chunk.subarray(from, Math.min(end, from + HEADER_BYTES - headerLength));
            header.push(Buffer.from(piece));
            headerLength += piece.length;
          }
          if (newline === -1) break;
          this.record(Buffer.concat(header).toString("utf8"), lineStart);
          lineStart = position + newline + 1;
          this.scannedTo = lineStart;
          header = [];
          headerLength = 0;
          from = newline + 1;
        }
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  private async readLineAt(offset: number): Promise<string | null> {
    const handle = await open(this.path, "r");
    try {
      const parts: Buffer[] = [];
      let position = offset;
      for (;;) {
        const buffer = Buffer.alloc(CHUNK_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
        if (bytesRead === 0) return parts.length > 0 ? Buffer.concat(parts).toString("utf8") : null;
        const chunk = buffer.subarray(0, bytesRead);
        const newline = chunk.indexOf(0x0a);
        if (newline !== -1) {
          parts.push(chunk.subarray(0, newline));
          return Buffer.concat(parts).toString("utf8");
        }
        parts.push(chunk);
        position += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
}
