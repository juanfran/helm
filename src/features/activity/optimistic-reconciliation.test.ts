import { describe, expect, it } from "vitest";

import {
  markAuthoritativeRows,
  reconcileOptimisticCommand,
  type OptimisticCollection,
} from "./optimistic-reconciliation";

type Row = { id: string; value: string };

function testCollection(initial: readonly Row[] = []) {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const collection: OptimisticCollection<Row> = {
    get(key) {
      return rows.get(key);
    },
    utils: {
      writeDelete(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) rows.delete(key);
      },
      writeUpsert(values) {
        for (const value of Array.isArray(values) ? values : [values]) {
          if (!value.id) throw new Error("A test row needs an identifier.");
          const current = rows.get(value.id);
          rows.set(value.id, {
            id: value.id,
            value: value.value ?? current?.value ?? "",
          });
        }
      },
    },
  };
  return { collection, rows };
}

describe("optimistic command reconciliation", () => {
  it("publishes immediately and replaces the optimistic row with the authoritative result", async () => {
    const { collection, rows } = testCollection();
    let release!: (response: { ok: true; row: Row }) => void;
    const response = new Promise<{ ok: true; row: Row }>((resolve) => {
      release = resolve;
    });

    const command = reconcileOptimisticCommand({
      collection,
      optimistic: { id: "row-1", value: "optimistic" },
      execute: () => response,
      outcome: (result) => ({ ok: true, value: result.row }),
    });
    expect(rows.get("row-1")?.value).toBe("optimistic");

    release({ ok: true, row: { id: "row-1", value: "authoritative" } });
    await command;
    expect(rows.get("row-1")?.value).toBe("authoritative");
  });

  it("restores prior state after a typed command failure", async () => {
    const previous = { id: "row-1", value: "before" };
    const { collection, rows } = testCollection([previous]);

    await reconcileOptimisticCommand({
      collection,
      optimistic: { id: "row-1", value: "optimistic" },
      previous,
      execute: async () => ({ ok: false as const }),
      outcome: () => ({ ok: false }),
    });

    expect(rows.get("row-1")).toEqual(previous);
  });

  it("removes a new optimistic row after a thrown transport failure", async () => {
    const { collection, rows } = testCollection();

    await expect(
      reconcileOptimisticCommand({
        collection,
        optimistic: { id: "row-1", value: "optimistic" },
        execute: async () => {
          throw new Error("connection lost");
        },
        outcome: () => ({ ok: false }),
      }),
    ).rejects.toThrow("connection lost");

    expect(rows.has("row-1")).toBe(false);
  });

  it("never rolls back an authoritative SSE row when a late response fails", async () => {
    const previous = { id: "row-1", value: "before" };
    const authoritative = { id: "row-1", value: "committed by SSE" };
    const { collection, rows } = testCollection([previous]);

    await reconcileOptimisticCommand({
      collection,
      optimistic: { id: "row-1", value: "optimistic" },
      previous,
      execute: async () => {
        markAuthoritativeRows(collection, [authoritative.id]);
        collection.utils.writeUpsert(authoritative);
        return { ok: false as const };
      },
      outcome: () => ({ ok: false }),
    });

    expect(rows.get("row-1")).toEqual(authoritative);
  });

  it("never replaces a newer SSE row with a late successful response", async () => {
    const authoritative = { id: "row-1", value: "newest state from SSE" };
    const { collection, rows } = testCollection();

    await reconcileOptimisticCommand({
      collection,
      optimistic: { id: "row-1", value: "optimistic" },
      execute: async () => {
        markAuthoritativeRows(collection, [authoritative.id]);
        collection.utils.writeUpsert(authoritative);
        return { ok: true as const, row: { id: "row-1", value: "older response" } };
      },
      outcome: (response) => ({ ok: true, value: response.row }),
    });

    expect(rows.get("row-1")).toEqual(authoritative);
  });

  it("rejects overlapping commands for one client ID without leaving a ghost row", async () => {
    const { collection, rows } = testCollection();
    let rejectFirst!: (error: Error) => void;
    const firstResponse = new Promise<{ ok: true; row: Row }>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const first = reconcileOptimisticCommand({
      collection,
      optimistic: { id: "row-1", value: "first" },
      execute: () => firstResponse,
      outcome: (response) => ({ ok: true, value: response.row }),
    });

    await expect(
      reconcileOptimisticCommand({
        collection,
        optimistic: { id: "row-1", value: "second" },
        execute: async () => ({ ok: false as const }),
        outcome: () => ({ ok: false }),
      }),
    ).rejects.toThrow("already pending");
    expect(rows.get("row-1")?.value).toBe("first");

    rejectFirst(new Error("first failed"));
    await expect(first).rejects.toThrow("first failed");
    expect(rows.has("row-1")).toBe(false);
  });
});
