import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { TanStackDevtools } from "@tanstack/react-devtools";

import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import { readAppState } from "../server/project-functions";
import { getThemeProps } from "../styles/theme";
import { tokens } from "../styles/tokens.stylex";

import appCss from "../styles.css?url";

import type { QueryClient } from "@tanstack/react-query";

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  loader: () => readAppState(),
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
  const { theme } = Route.useLoaderData();
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
