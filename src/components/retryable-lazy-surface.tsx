import { useCallback, type ComponentType, type ReactNode } from "react";

import type { RetryableLazyModuleLoader } from "./retryable-lazy-module";
import { useRetryableModule } from "./use-retryable-module";

type LazyComponentModule<Props> = { default: ComponentType<Props> };

export function RetryableLazySurface<Props>({
  moduleLoader,
  fallback,
  render,
  renderFailure,
}: {
  moduleLoader: RetryableLazyModuleLoader<LazyComponentModule<Props>>;
  fallback: ReactNode;
  render: (LoadedComponent: ComponentType<Props>) => ReactNode;
  renderFailure: (retry: () => void) => ReactNode;
}) {
  const { state, retry: requestRetry } = useRetryableModule(moduleLoader);
  const retry = useCallback(() => {
    moduleLoader.reset();
    requestRetry();
  }, [moduleLoader, requestRetry]);

  if (state.status === "loading") return fallback;
  if (state.status === "error") return renderFailure(retry);
  return render(state.module.default);
}
