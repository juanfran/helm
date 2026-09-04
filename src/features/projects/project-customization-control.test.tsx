// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  customFieldDefinitionSchema,
  projectCustomizationSnapshotSchema,
  type AddCustomFieldDefinitionInput,
  type CustomFieldDefinition,
  type ProjectCustomizationSnapshot,
  type ReorderCustomFieldDefinitionsInput,
  type RetireCustomFieldDefinitionInput,
  type SetTagReviewModeOverrideInput,
} from "../../domain/customization";
import type { TaskTag } from "../../domain/tasks";
import type { CustomizationCommandResponse } from "../../server/customization-adapter";
import {
  ProjectCustomizationControl,
  type ProjectCustomizationControlProps,
} from "./project-customization-control";

const timestamp = "2026-09-04T12:00:00.000Z";

function textDefinition(overrides: Partial<Extract<CustomFieldDefinition, { type: "text" }>> = {}) {
  return customFieldDefinitionSchema.parse({
    id: "field-summary",
    projectId: "project-1",
    key: "summary",
    type: "text",
    validation: { minLength: 0, maxLength: 100 },
    defaultValue: null,
    display: { label: "Summary", description: "A compact status." },
    position: 0,
    retiredAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function numberDefinition(
  overrides: Partial<Extract<CustomFieldDefinition, { type: "number" }>> = {},
) {
  return customFieldDefinitionSchema.parse({
    id: "field-risk",
    projectId: "project-1",
    key: "risk",
    type: "number",
    validation: { min: 1, max: 5, integer: true },
    defaultValue: { type: "number", value: 3 },
    display: { label: "Risk", description: "Delivery risk." },
    position: 1,
    retiredAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function retiredBooleanDefinition() {
  return customFieldDefinitionSchema.parse({
    id: "field-legacy",
    projectId: "project-1",
    key: "legacy",
    type: "boolean",
    validation: {},
    defaultValue: { type: "boolean", value: false },
    display: { label: "Legacy", description: "Preserved historical field." },
    position: 2,
    retiredAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function customization(
  overrides: Partial<ProjectCustomizationSnapshot> = {},
): ProjectCustomizationSnapshot {
  return projectCustomizationSnapshotSchema.parse({
    schemaVersion: 1,
    projectId: "project-1",
    projectVersion: 3,
    definitions: [],
    tagReviewRules: [],
    ...overrides,
  });
}

const tags: readonly TaskTag[] = [
  {
    id: "tag-frontend",
    name: "Frontend",
    description: "Browser-facing work",
    color: "#2563eb",
    exclusiveGroup: "area",
    reviewModeOverride: "required",
  },
  {
    id: "tag-backend",
    name: "Backend",
    description: "Server-facing work",
    color: "#166534",
    exclusiveGroup: "area",
    reviewModeOverride: null,
  },
];

function success(snapshot: ProjectCustomizationSnapshot): CustomizationCommandResponse {
  return { ok: true, customization: snapshot };
}

function renderControl(overrides: Partial<ProjectCustomizationControlProps> = {}) {
  const initial = overrides.customization ?? customization();
  const defaultCommand = async () => success(initial);
  const props: ProjectCustomizationControlProps = {
    customization: initial,
    tagDefinitions: tags,
    onAddFieldDefinition: defaultCommand,
    onRetireFieldDefinition: defaultCommand,
    onReorderFieldDefinitions: defaultCommand,
    onChangeTagReviewModeOverride: defaultCommand,
    ...overrides,
  };
  function Harness() {
    const [authoritative, setAuthoritative] = useState(initial);
    async function apply(
      command: Promise<CustomizationCommandResponse>,
    ): Promise<CustomizationCommandResponse> {
      const response = await command;
      if (response.ok) setAuthoritative(response.customization);
      return response;
    }
    return (
      <ProjectCustomizationControl
        {...props}
        customization={authoritative}
        onAddFieldDefinition={(input) => apply(props.onAddFieldDefinition(input))}
        onRetireFieldDefinition={(input) => apply(props.onRetireFieldDefinition(input))}
        onReorderFieldDefinitions={(input) => apply(props.onReorderFieldDefinitions(input))}
        onChangeTagReviewModeOverride={(input) => apply(props.onChangeTagReviewModeOverride(input))}
      />
    );
  }
  return render(<Harness />);
}

async function startField(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  key: string,
  type: "text" | "number" | "boolean" | "date" | "single_select",
) {
  await user.click(screen.getByRole("button", { name: "Add custom field" }));
  await user.type(screen.getByLabelText("Display label"), label);
  await user.type(screen.getByLabelText("Machine key"), key);
  await user.type(screen.getByLabelText("Description"), `${label} detail`);
  if (type !== "text") await user.selectOptions(screen.getByLabelText("Field type"), type);
}

async function submitField(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Create field" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ProjectCustomizationControl", () => {
  it("creates all five field types with explicit display, validation, and typed defaults", async () => {
    const user = userEvent.setup();
    let serverSnapshot = customization();
    const onAddFieldDefinition = vi.fn(async (_input: AddCustomFieldDefinitionInput) => {
      serverSnapshot = customization({ projectVersion: serverSnapshot.projectVersion + 1 });
      return success(serverSnapshot);
    });
    renderControl({ customization: serverSnapshot, onAddFieldDefinition });

    await startField(user, "Summary", "summary", "text");
    await user.clear(screen.getByLabelText("Minimum length"));
    await user.type(screen.getByLabelText("Minimum length"), "2");
    await user.clear(screen.getByLabelText("Maximum length"));
    await user.type(screen.getByLabelText("Maximum length"), "80");
    await user.click(screen.getByRole("checkbox", { name: "Set a text default" }));
    await user.type(screen.getByLabelText("Default text"), "Untriaged");
    await submitField(user);

    await startField(user, "Score", "score", "number");
    await user.type(screen.getByLabelText("Minimum number"), "0.25");
    await user.type(screen.getByLabelText("Maximum number"), "10.5");
    await user.click(screen.getByRole("checkbox", { name: "Set a number default" }));
    await user.type(screen.getByLabelText("Default number"), "4.5");
    await submitField(user);

    await startField(user, "Customer visible", "customer_visible", "boolean");
    await user.selectOptions(screen.getByLabelText("Default boolean"), "false");
    await submitField(user);

    await startField(user, "Release date", "release_date", "date");
    await user.type(screen.getByLabelText("Earliest date"), "2026-01-01");
    await user.type(screen.getByLabelText("Latest date"), "2026-12-31");
    await user.type(screen.getByLabelText("Default date"), "2026-09-30");
    await submitField(user);

    await startField(user, "Risk level", "risk_level", "single_select");
    await user.type(screen.getByLabelText("Options"), "low: Low{enter}high: High");
    await user.type(screen.getByLabelText("Default option identifier"), "low");
    await submitField(user);

    expect(onAddFieldDefinition).toHaveBeenCalledTimes(5);
    expect(onAddFieldDefinition.mock.calls.map(([input]) => input.expectedProjectVersion)).toEqual([
      3, 4, 5, 6, 7,
    ]);
    expect(onAddFieldDefinition.mock.calls.map(([input]) => input.definition)).toEqual([
      {
        key: "summary",
        type: "text",
        display: { label: "Summary", description: "Summary detail" },
        validation: { minLength: 2, maxLength: 80 },
        defaultValue: { type: "text", value: "Untriaged" },
      },
      {
        key: "score",
        type: "number",
        display: { label: "Score", description: "Score detail" },
        validation: { min: 0.25, max: 10.5, integer: false },
        defaultValue: { type: "number", value: 4.5 },
      },
      {
        key: "customer_visible",
        type: "boolean",
        display: { label: "Customer visible", description: "Customer visible detail" },
        validation: {},
        defaultValue: { type: "boolean", value: false },
      },
      {
        key: "release_date",
        type: "date",
        display: { label: "Release date", description: "Release date detail" },
        validation: { min: "2026-01-01", max: "2026-12-31" },
        defaultValue: { type: "date", value: "2026-09-30" },
      },
      {
        key: "risk_level",
        type: "single_select",
        display: { label: "Risk level", description: "Risk level detail" },
        validation: {
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
        defaultValue: { type: "single_select", value: "low" },
      },
    ]);
    expect(
      onAddFieldDefinition.mock.calls.every(([input]) => input.idempotencyKey.length > 0),
    ).toBe(true);
    expect(screen.getByLabelText("Configuration state").textContent).toBe("Configuration v8");
    expect(screen.getByRole("status").textContent).toContain("Risk level created");
  });

  it("announces client validation without calling the command", async () => {
    const user = userEvent.setup();
    const onAddFieldDefinition = vi.fn();
    renderControl({ onAddFieldDefinition });

    await startField(user, "Summary", "summary", "text");
    await user.clear(screen.getByLabelText("Minimum length"));
    await user.type(screen.getByLabelText("Minimum length"), "20");
    await user.clear(screen.getByLabelText("Maximum length"));
    await user.type(screen.getByLabelText("Maximum length"), "5");
    await user.click(screen.getByRole("button", { name: "Create field" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Check the custom-field configuration.");
    expect(alert.textContent).toContain("minimum text length must not exceed");
    expect(onAddFieldDefinition).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("renders ordered active and retired definitions, reorders the full active set, and confirms retirement", async () => {
    const user = userEvent.setup();
    const initial = customization({
      definitions: [numberDefinition(), retiredBooleanDefinition(), textDefinition()],
    });
    const reordered = customization({
      projectVersion: 4,
      definitions: [
        numberDefinition({ position: 0 }),
        textDefinition({ position: 1 }),
        retiredBooleanDefinition(),
      ],
    });
    const retired = customization({
      projectVersion: 5,
      definitions: [
        numberDefinition({ position: 0, retiredAt: "2026-09-04T13:00:00.000Z" }),
        textDefinition({ position: 1 }),
        retiredBooleanDefinition(),
      ],
    });
    const onReorderFieldDefinitions = vi.fn(async (_input: ReorderCustomFieldDefinitionsInput) =>
      success(reordered),
    );
    const onRetireFieldDefinition = vi.fn(async (_input: RetireCustomFieldDefinitionInput) =>
      success(retired),
    );
    renderControl({
      customization: initial,
      onReorderFieldDefinitions,
      onRetireFieldDefinition,
    });

    const active = screen.getByRole("list", { name: "Active fields" });
    expect(
      within(active)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("Summary"), expect.stringContaining("Risk")]);
    expect(
      within(screen.getByRole("list", { name: "Retired fields" })).getByText("Legacy"),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Move Summary down" }));
    expect(onReorderFieldDefinitions).toHaveBeenCalledWith({
      projectId: "project-1",
      orderedFieldIds: ["field-risk", "field-summary"],
      expectedProjectVersion: 3,
      idempotencyKey: expect.any(String),
    });
    await waitFor(() =>
      expect(within(active).getAllByRole("listitem")[0]?.textContent).toContain("Risk"),
    );

    await user.click(screen.getByRole("button", { name: "Retire Risk" }));
    expect(screen.getByRole("dialog").textContent).toContain("Existing task values are preserved");
    expect(screen.getByRole("button", { name: "Retire field" })).toHaveProperty("disabled", true);
    await user.type(screen.getByLabelText("Reason for retirement"), "Replaced by delivery_risk.");
    await user.click(screen.getByRole("button", { name: "Retire field" }));

    expect(onRetireFieldDefinition).toHaveBeenCalledWith({
      projectId: "project-1",
      fieldId: "field-risk",
      reason: "Replaced by delivery_risk.",
      expectedProjectVersion: 4,
      idempotencyKey: expect.any(String),
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      within(screen.getByRole("list", { name: "Active fields" })).queryByText("Risk"),
    ).toBeNull();
    expect(
      within(screen.getByRole("list", { name: "Retired fields" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining("Risk"), expect.stringContaining("Legacy")]);
    expect(screen.getByLabelText("Configuration state").textContent).toBe("Configuration v5");
  });

  it("sets and clears tag policy overrides against the latest version", async () => {
    const user = userEvent.setup();
    const initial = customization({
      tagReviewRules: [{ tagId: "tag-frontend", tagName: "Frontend", reviewMode: "required" }],
    });
    let serverSnapshot = initial;
    const onChangeTagReviewModeOverride = vi.fn(async (input: SetTagReviewModeOverrideInput) => {
      serverSnapshot = customization({
        projectVersion: serverSnapshot.projectVersion + 1,
        tagReviewRules:
          input.reviewModeOverride === null
            ? []
            : [
                {
                  tagId: input.tagId,
                  tagName: "Frontend",
                  reviewMode: input.reviewModeOverride,
                },
              ],
      });
      return success(serverSnapshot);
    });
    renderControl({ customization: initial, onChangeTagReviewModeOverride });

    expect(screen.getByLabelText("Review policy for Frontend")).toHaveProperty("value", "required");
    await user.selectOptions(screen.getByLabelText("Review policy for Frontend"), "direct");
    expect(onChangeTagReviewModeOverride).toHaveBeenLastCalledWith({
      projectId: "project-1",
      tagId: "tag-frontend",
      reviewModeOverride: "direct",
      expectedProjectVersion: 3,
      reason: "Allow direct completion for tag Frontend.",
      idempotencyKey: expect.any(String),
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Review policy for Frontend")).toHaveProperty("value", "direct"),
    );

    await user.selectOptions(screen.getByLabelText("Review policy for Frontend"), "");
    expect(onChangeTagReviewModeOverride).toHaveBeenLastCalledWith({
      projectId: "project-1",
      tagId: "tag-frontend",
      reviewModeOverride: null,
      expectedProjectVersion: 4,
      reason: "Use the project review policy for tag Frontend.",
      idempotencyKey: expect.any(String),
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Review policy for Frontend")).toHaveProperty("value", ""),
    );
    expect(screen.getByLabelText("Configuration state").textContent).toBe("Configuration v5");
  });

  it("keeps displayed state intact and exposes complete version-conflict recovery details", async () => {
    const user = userEvent.setup();
    const initial = customization({ definitions: [textDefinition(), numberDefinition()] });
    const onReorderFieldDefinitions = vi.fn(async () => ({
      ok: false as const,
      error: {
        type: "CustomizationVersionConflictError" as const,
        message: "Project configuration changed while this page was open.",
        projectId: "project-1",
        expectedVersion: 3,
        currentVersion: 7,
        changeSummary: "Another actor added field deployment_ring.",
      },
    }));
    renderControl({ customization: initial, onReorderFieldDefinitions });

    await user.click(screen.getByRole("button", { name: "Move Summary down" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Configuration version conflict");
    expect(alert.textContent).toContain("Displayed version: 3");
    expect(alert.textContent).toContain("Current server version: 7");
    expect(alert.textContent).toContain("Another actor added field deployment_ring.");
    expect(alert.textContent).toContain("Reload the project configuration before retrying.");
    expect(screen.getByLabelText("Configuration state").textContent).toBe("Configuration v3");
    expect(
      within(screen.getByRole("list", { name: "Active fields" })).getAllByRole("listitem")[0]
        ?.textContent,
    ).toContain("Summary");
  });
});
