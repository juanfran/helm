import { useEffect } from "react";
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
  useRouter,
} from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";

import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import { subscribeToApplicationChanges } from "../features/projects/active-project-subscription";
import {
  activeAgentRunsQueryKey,
  refreshActiveAgentRuns,
} from "../features/dashboard/agent-runs-query";
import { resetProjectNavigation } from "../features/projects/project-navigation";
import { readApplicationEventCursor } from "../server/application-cursor-function";
import { readAppState } from "../server/project-functions";
import { getThemeProps } from "../styles/theme";
import { tokens } from "../styles/tokens.stylex";

import appCss from "../styles.css?url";

import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  loader: async ({ context }) => {
    // Capture the global cursor before every application snapshot. A selection or agent-run change
    // committed later is either reflected in a snapshot or replayed by the replacement subscription.
    const applicationEventCursor = await readApplicationEventCursor();
    const [state] = await Promise.all([
      readAppState(),
      refreshActiveAgentRuns(context.queryClient),
    ]);
    return { ...state, applicationEventCursor };
  },
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Helm",
      },
      {
        name: "description",
        content: "A local control plane for one developer and many coding agents.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      ...(import.meta.env.PROD
        ? [
            {
              rel: "stylesheet",
              href: "/stylex.css",
            },
          ]
        : []),
    ],
  }),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  const { theme, applicationEventCursor } = Route.useLoaderData();
  const router = useRouter();
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeToApplicationChanges({
        afterCursor: applicationEventCursor,
        onActiveProjectChange: () =>
          resetProjectNavigation({
            navigateToWorkspace: () => router.navigate({ to: "/", replace: true }),
            refreshRoutes: () => router.invalidate({ sync: true }),
          }),
        onAgentRunChange: () =>
          queryClient.invalidateQueries({ queryKey: activeAgentRunsQueryKey }),
      }),
    [applicationEventCursor, queryClient, router],
  );

  return (
    <html lang="en" data-theme={theme} {...getThemeProps(theme)}>
      <head>
        <HeadContent />
      </head>
      <body {...stylex.props(styles.body)}>
        {children}
        {import.meta.env.DEV ? (
          <TanStackDevtools
            config={{
              position: "bottom-right",
            }}
            plugins={[
              {
                name: "TanStack Router",
                render: <TanStackRouterDevtoolsPanel />,
              },
              TanStackQueryDevtools,
            ]}
          />
        ) : null}
        <Scripts />
      </body>
    </html>
  );
}

const styles = stylex.create({
  body: {
    backgroundColor: tokens.background,
    color: tokens.foreground,
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    minHeight: "100vh",
  },
});
