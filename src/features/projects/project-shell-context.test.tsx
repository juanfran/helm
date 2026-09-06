// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  ProjectShellContext,
  useProjectShellConnection,
  type ProjectConnectionStatus,
} from "./project-shell-context";

afterEach(cleanup);

const reportConnection = vi.fn();
const context = { reportConnection };

function Page({ status }: { status: ProjectConnectionStatus }) {
  useProjectShellConnection(status);
  return null;
}

it("retains the last project status across page initialization but reports actual connection changes", () => {
  const view = render(
    <ProjectShellContext.Provider value={context}>
      <Page status="live" />
    </ProjectShellContext.Provider>,
  );
  expect(reportConnection).toHaveBeenLastCalledWith("live");
  view.rerender(
    <ProjectShellContext.Provider value={context}>
      <Page key="next-page" status="connecting" />
    </ProjectShellContext.Provider>,
  );
  expect(reportConnection).toHaveBeenCalledTimes(1);
  view.rerender(
    <ProjectShellContext.Provider value={context}>
      <Page key="next-page" status="retrying" />
    </ProjectShellContext.Provider>,
  );
  expect(reportConnection).toHaveBeenLastCalledWith("retrying");
});
