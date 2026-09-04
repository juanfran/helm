// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseTaskSearchRouteParams } from "./task-search-route-params";
import { SearchFilterControls } from "./task-route-controls";

afterEach(cleanup);

describe("split search filter controls", () => {
  it("preserves the validated query and resets pagination when applying filters", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(
      ["task-tags", "project-1"],
      [
        {
          id: "tag-1",
          name: "Release",
          description: "Release work",
          color: "#336699",
          exclusiveGroup: null,
          reviewModeOverride: null,
        },
      ],
    );
    const onApply = vi.fn();

    render(
      <QueryClientProvider client={queryClient}>
        <SearchFilterControls
          projectId="project-1"
          search={parseTaskSearchRouteParams({ presentation: "board", cursor: "tq2.old" })}
          onApply={onApply}
        />
      </QueryClientProvider>,
    );

    await user.type(screen.getByRole("textbox", { name: "Search text" }), "review evidence");
    await user.selectOptions(screen.getByRole("combobox", { name: "Search mode" }), "phrase");
    await user.selectOptions(screen.getByRole("combobox", { name: "Lifecycle" }), "review");
    await user.selectOptions(screen.getByRole("combobox", { name: "Eligibility" }), "blocked");
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority" }), "high");
    await user.selectOptions(screen.getByRole("combobox", { name: "Tag" }), "tag-1");
    await user.type(screen.getByRole("textbox", { name: "Required capability" }), "TypeScript");
    await user.click(screen.getByRole("button", { name: "Apply query" }));

    expect(onApply).toHaveBeenCalledWith({
      q: "review evidence",
      mode: "phrase",
      lifecycle: "review",
      eligibility: "blocked",
      priority: "high",
      tag: "tag-1",
      capability: "TypeScript",
      presentation: "board",
      cursor: null,
    });
  });
});
