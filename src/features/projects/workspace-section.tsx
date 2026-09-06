import { Component, Suspense, createContext, useContext, type ReactNode } from "react";
import { RouteErrorState, RoutePendingState } from "../../components/route-state";
import type { WorkspaceData } from "./workspace-data";

type SectionData = Pick<WorkspaceData, "resources">;
export const WorkspaceDataContext = createContext<SectionData | null>(null);
export function DeferredSection({
  label,
  onRetry,
  children,
}: {
  label: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  return (
    <SectionErrorBoundary label={label} onRetry={onRetry}>
      <Suspense fallback={<RoutePendingState label={`Loading ${label.toLowerCase()}…`} />}>
        {children}
      </Suspense>
    </SectionErrorBoundary>
  );
}
type Props = {
  label: string;
  resources: readonly (keyof WorkspaceData["resources"])[];
  children: ReactNode;
};

export function WorkspaceSection({ label, resources, children }: Props) {
  const data = useContext(WorkspaceDataContext);
  if (!data) return children;
  return (
    <SectionErrorBoundary
      label={label}
      onRetry={() => {
        for (const key of resources) data.resources[key].retry();
      }}
    >
      <Suspense fallback={<RoutePendingState label={`Loading ${label.toLowerCase()}…`} />}>
        <ReadySection data={data} resources={resources}>
          {children}
        </ReadySection>
      </Suspense>
    </SectionErrorBoundary>
  );
}

function ReadySection({
  data,
  resources,
  children,
}: {
  data: SectionData;
  resources: Props["resources"];
  children: ReactNode;
}) {
  for (const key of resources) data.resources[key].read();
  return children;
}

class SectionErrorBoundary extends Component<
  { label: string; onRetry: () => void; children: ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <RouteErrorState
          title={`${this.props.label} could not be loaded`}
          error={this.state.error}
          onRetry={() => {
            this.props.onRetry();
            this.setState({ error: null });
          }}
        />
      );
    return this.props.children;
  }
}
