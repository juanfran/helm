import { type FormEvent } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { Search as SearchIcon } from "lucide-react";

import { ActionButton as Button } from "../../components/ui/action-button";
import { tokens } from "../../styles/tokens.stylex";
import { parseTaskSearchRouteParams, type TaskSearchParams } from "./task-search-route-params";
import { taskTagsQueryOptions } from "./task-tags-query";

export type SearchFilterControlsProps = {
  readonly projectId: string;
  readonly search: TaskSearchParams;
  readonly onApply: (search: TaskSearchParams) => void | Promise<void>;
};

function formString(data: FormData, name: string) {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

export function SearchFilterControls({ projectId, search, onApply }: SearchFilterControlsProps) {
  const { data: tags } = useSuspenseQuery(taskTagsQueryOptions(projectId));
  const searchFormKey = JSON.stringify({
    q: search.q,
    mode: search.mode,
    lifecycle: search.lifecycle,
    eligibility: search.eligibility,
    priority: search.priority,
    tag: search.tag,
    capability: search.capability,
  });

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextSearch = parseTaskSearchRouteParams({
      ...search,
      q: formString(data, "q"),
      mode: formString(data, "mode"),
      lifecycle: formString(data, "lifecycle") || null,
      eligibility: formString(data, "eligibility") || null,
      priority: formString(data, "priority") || null,
      tag: formString(data, "tag") || null,
      capability: formString(data, "capability") || null,
      cursor: null,
    });
    void onApply(nextSearch);
  }

  return (
    <form
      key={searchFormKey}
      onSubmit={submitSearch}
      aria-label="Search and filter tasks"
      {...stylex.props(styles.searchForm)}
    >
      <label {...stylex.props(styles.searchField)}>
        <span {...stylex.props(styles.srOnly)}>Search text</span>
        <SearchIcon size={17} aria-hidden="true" />
        <input
          name="q"
          defaultValue={search.q}
          placeholder="Search work and history"
          maxLength={500}
          {...stylex.props(styles.input, styles.searchInput)}
        />
      </label>
      <select
        name="mode"
        defaultValue={search.mode}
        aria-label="Search mode"
        {...stylex.props(styles.select)}
      >
        <option value="all">All words</option>
        <option value="any">Any word</option>
        <option value="phrase">Exact phrase</option>
      </select>
      <select
        name="lifecycle"
        defaultValue={search.lifecycle ?? ""}
        aria-label="Lifecycle"
        {...stylex.props(styles.select)}
      >
        <option value="">All lifecycle states</option>
        <option value="backlog">Backlog</option>
        <option value="ready">Ready</option>
        <option value="in_progress">In progress</option>
        <option value="review">Review</option>
        <option value="done">Done</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <select
        name="eligibility"
        defaultValue={search.eligibility ?? ""}
        aria-label="Eligibility"
        {...stylex.props(styles.select)}
      >
        <option value="">All eligibility</option>
        <option value="claimable">Claimable</option>
        <option value="claimed">Claimed</option>
        <option value="scheduled">Scheduled</option>
        <option value="blocked">Blocked</option>
        <option value="capability_mismatch">Capability mismatch</option>
        <option value="not_ready">Not ready</option>
        <option value="complete">Complete</option>
        <option value="archived">Archived</option>
      </select>
      <select
        name="priority"
        defaultValue={search.priority ?? ""}
        aria-label="Priority"
        {...stylex.props(styles.select)}
      >
        <option value="">All priorities</option>
        <option value="urgent">Urgent</option>
        <option value="high">High</option>
        <option value="normal">Normal</option>
        <option value="low">Low</option>
      </select>
      <select
        name="tag"
        defaultValue={search.tag ?? ""}
        aria-label="Tag"
        {...stylex.props(styles.select)}
      >
        <option value="">All tags</option>
        {tags.map((tag) => (
          <option key={tag.id} value={tag.id}>
            {tag.name}
          </option>
        ))}
      </select>
      <input
        name="capability"
        defaultValue={search.capability ?? ""}
        placeholder="Required capability"
        aria-label="Required capability"
        maxLength={80}
        {...stylex.props(styles.input)}
      />
      <Button type="submit">Apply query</Button>
    </form>
  );
}

const styles = stylex.create({
  searchForm: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "minmax(220px, 2fr) repeat(3, minmax(120px, 1fr))",
    padding: tokens.space3,
    "@media (max-width: 1050px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
  },
  searchField: {
    alignItems: "center",
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "flex",
    gap: tokens.space2,
    minWidth: 0,
    paddingInline: tokens.space3,
    ":focus-within": {
      borderColor: tokens.accent,
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  input: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    font: "inherit",
    minHeight: 38,
    minWidth: 0,
    paddingInline: tokens.space3,
    ":focus": { borderColor: tokens.accent, outline: "none" },
  },
  searchInput: { borderStyle: "none", paddingInline: 0, width: "100%" },
  select: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    color: tokens.foreground,
    font: "inherit",
    minHeight: 38,
    minWidth: 0,
    paddingInline: tokens.space2,
  },
  srOnly: {
    clip: "rect(0, 0, 0, 0)",
    clipPath: "inset(50%)",
    height: 1,
    overflow: "hidden",
    position: "absolute",
    whiteSpace: "nowrap",
    width: 1,
  },
});
