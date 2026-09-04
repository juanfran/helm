import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const { readProjectCustomization } = vi.hoisted(() => ({
  readProjectCustomization: vi.fn(),
}));

vi.mock("../../server/customization-functions", () => ({ readProjectCustomization }));

import { refreshProjectCustomization } from "./project-customization-query";

describe("project customization query", () => {
  it("replaces a cached aggregate version when a project-scoped event is observed", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const projectId = "project-1";
    const previous = {
      schemaVersion: 1 as const,
      projectId,
      projectVersion: 2,
      definitions: [],
      tagReviewRules: [],
    };
    const current = { ...previous, projectVersion: 3 };
    queryClient.setQueryData(["project-customization", projectId], previous);
    readProjectCustomization.mockResolvedValueOnce(current);

    await expect(refreshProjectCustomization(queryClient, projectId)).resolves.toEqual(current);

    expect(readProjectCustomization).toHaveBeenCalledWith({
      data: { projectId, includeRetired: true },
    });
    expect(queryClient.getQueryData(["project-customization", projectId])).toEqual(current);
  });
});
