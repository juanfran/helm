import { describe, expect, it } from "vitest";

import { Route as SearchRoute } from "../../routes/$projectId.search";
import { Route as SavedViewRoute } from "../../routes/$projectId.views.$viewId";
import { SavedViewPage } from "./saved-view-page";
import { SearchPage } from "./task-search-page";

describe("task route intent preload contract", () => {
  it("makes each navigation-critical page the direct route component split", () => {
    expect(SearchRoute.options.component).toBe(SearchPage);
    expect(SavedViewRoute.options.component).toBe(SavedViewPage);
    expect(SearchRoute.options.codeSplitGroupings).toContainEqual(["component"]);
    expect(SavedViewRoute.options.codeSplitGroupings).toContainEqual(["component"]);
  });
});
