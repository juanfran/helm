---
name: helm-ui
description: Applies Helm's StyleX design system and Base UI component conventions with fast route loading. Use when creating components, themes, task views, navigation, responsive behavior, TipTap surfaces, or visual states.
---

# Helm UI

## Workflow

1. Read the presentation and client-data sections of [`docs/architecture.md`](../../../docs/architecture.md).
2. Start from an existing repository component. When no component fits, use a Base UI primitive and consult the configured shadcn Base UI registry for behavior.
3. Translate all registry styling into `stylex.create`; keep global CSS limited to normalization.
4. Add reusable values to exported StyleX variables. Keep variants as typed props and keep arbitrary class strings out of component APIs.
5. Choose the data owner: TanStack DB for reactive records, TanStack Query only for isolated non-collection reads.
6. Preload route data in loaders. Use Suspense and a route-level error boundary; avoid component-mount fetches for navigation-critical data.
7. Design the dense desktop workflow first. Add narrow-screen monitoring and review behavior only when it stays local to presentation.
8. Verify keyboard operation, focus visibility, light/dark contrast, loading, empty, error, optimistic, and conflict states.
9. Run `pnpm check` and `pnpm build`. The change is complete when the route has no avoidable loading flash and all interactive states remain accessible.

## Design constraints

- StyleX tokens are the visual source of truth.
- Base UI is the primitive layer; repository components own product semantics.
- List views are primary. Boards are secondary views over the same data.
- Motion communicates state change and respects reduced-motion preferences.
- Mobile adaptations cannot introduce a second navigation or data architecture.
