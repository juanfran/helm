import { useCallback, useEffect, useRef, useState } from "react";

import type { RetryableLazyModuleLoader } from "./retryable-lazy-module";

export type ExplicitLazyModuleState<TModule> =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly module: TModule }
  | { readonly status: "error"; readonly error: unknown };

/**
 * Loads an interaction-only module after explicit activation. Pointer and keyboard intent may warm
 * the same retryable promise, but mounting this hook never starts an import.
 */
export function useExplicitLazyModule<TModule>(moduleLoader: RetryableLazyModuleLoader<TModule>) {
  const [state, setState] = useState<ExplicitLazyModuleState<TModule>>({ status: "idle" });
  const active = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      requestId.current += 1;
    };
  }, []);

  const preload = useCallback(() => moduleLoader.preload(), [moduleLoader]);

  const load = useCallback(
    (reset: boolean) => {
      const currentRequestId = requestId.current + 1;
      requestId.current = currentRequestId;
      if (reset) moduleLoader.reset();
      setState({ status: "loading" });
      void moduleLoader.load().then(
        (module) => {
          if (active.current && requestId.current === currentRequestId) {
            setState({ status: "ready", module });
          }
        },
        (error: unknown) => {
          if (active.current && requestId.current === currentRequestId) {
            setState({ status: "error", error });
          }
        },
      );
    },
    [moduleLoader],
  );

  return {
    state,
    preload,
    activate: useCallback(() => load(false), [load]),
    retry: useCallback(() => load(true), [load]),
  } as const;
}
