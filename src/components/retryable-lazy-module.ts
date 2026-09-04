export type RetryableLazyModuleLoader<T> = {
  readonly load: () => Promise<T>;
  readonly preload: () => void;
  readonly reset: () => void;
};

export function createRetryableLazyModuleLoader<T>(
  loadModule: () => Promise<T>,
): RetryableLazyModuleLoader<T> {
  let modulePromise: Promise<T> | null = null;

  function load() {
    if (modulePromise) return modulePromise;

    const attempt = Promise.resolve().then(loadModule);
    modulePromise = attempt;
    void attempt.catch(() => {
      if (modulePromise === attempt) modulePromise = null;
    });
    return attempt;
  }

  function preload() {
    void load().catch(() => undefined);
  }

  function reset() {
    modulePromise = null;
  }

  return { load, preload, reset };
}
