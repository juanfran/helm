import { useCallback, useEffect, useState } from "react";

export type RetryableModuleLoader<TModule> = {
  load: () => Promise<TModule>;
};

type RetryableModuleState<TModule> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly module: TModule }
  | { readonly status: "error"; readonly error: unknown };

export function useRetryableModule<TModule>(loader: RetryableModuleLoader<TModule>) {
  const [request, setRequest] = useState<{
    readonly id: number;
    readonly state: RetryableModuleState<TModule>;
  }>({ id: 0, state: { status: "loading" } });

  useEffect(() => {
    let active = true;
    const requestId = request.id;
    void loader.load().then(
      (module) => {
        if (active) {
          setRequest((current) =>
            current.id === requestId
              ? { id: requestId, state: { status: "ready", module } }
              : current,
          );
        }
      },
      (error: unknown) => {
        if (active) {
          setRequest((current) =>
            current.id === requestId
              ? { id: requestId, state: { status: "error", error } }
              : current,
          );
        }
      },
    );
    return () => {
      active = false;
    };
  }, [loader, request.id]);

  return {
    state: request.state,
    retry: useCallback(
      () =>
        setRequest((current) => ({
          id: current.id + 1,
          state: { status: "loading" },
        })),
      [],
    ),
  } as const;
}
