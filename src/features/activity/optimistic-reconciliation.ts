export type AuthoritativeCollection<T extends { id: string }> = {
  utils: {
    writeDelete(keys: string | string[]): void;
    writeUpsert(rows: Partial<T> | Array<Partial<T>>): void;
  };
};

export type OptimisticCollection<T extends { id: string }> = AuthoritativeCollection<T> & {
  get(key: string): T | undefined;
};

type OptimisticOutcome<T> = { ok: true; value: T } | { ok: false };

const rowGenerations = new WeakMap<object, Map<string, number>>();
const pendingRows = new WeakMap<object, Set<string>>();

function emptyRollback() {}

function generationsFor(collection: object) {
  let generations = rowGenerations.get(collection);
  if (!generations) {
    generations = new Map();
    rowGenerations.set(collection, generations);
  }
  return generations;
}

function advanceRow(collection: object, key: string) {
  const generations = generationsFor(collection);
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
}

export function markAuthoritativeRows<T extends { id: string }>(
  collection: AuthoritativeCollection<T>,
  keys: readonly string[],
) {
  for (const key of new Set(keys)) advanceRow(collection, key);
}

export async function reconcileOptimisticCommand<T extends { id: string }, R>({
  collection,
  optimistic,
  previous,
  execute,
  outcome,
  applyAuthoritative = (apply) => apply(),
}: {
  collection: OptimisticCollection<T>;
  optimistic: T;
  previous?: T;
  execute: () => Promise<R>;
  outcome: (response: R) => OptimisticOutcome<T>;
  applyAuthoritative?: (apply: () => void) => Promise<void> | void;
}) {
  let pending = pendingRows.get(collection);
  if (!pending) {
    pending = new Set();
    pendingRows.set(collection, pending);
  }
  if (pending.has(optimistic.id)) {
    throw new Error(`An optimistic command for ${optimistic.id} is already pending.`);
  }
  pending.add(optimistic.id);
  let rollback: () => void = emptyRollback;

  try {
    const generation = advanceRow(collection, optimistic.id);
    collection.utils.writeUpsert(optimistic);
    const optimisticSnapshot = collection.get(optimistic.id);
    const isCurrent = () =>
      generationsFor(collection).get(optimistic.id) === generation &&
      collection.get(optimistic.id) === optimisticSnapshot;
    rollback = () => {
      if (!isCurrent()) return;
      if (previous) collection.utils.writeUpsert(previous);
      else collection.utils.writeDelete(optimistic.id);
      advanceRow(collection, optimistic.id);
    };

    const response = await execute();
    const result = outcome(response);
    if (!result.ok) {
      rollback();
      return response;
    }
    await applyAuthoritative(() => {
      if (!isCurrent()) return;
      collection.utils.writeUpsert(result.value);
      advanceRow(collection, optimistic.id);
    });
    return response;
  } catch (error) {
    rollback();
    throw error;
  } finally {
    pending.delete(optimistic.id);
  }
}
