# ADR 0003: Use the KétViệt staff/operational design language

- Status: accepted
- Date: 2026-08-03

## Context

PhaseAtlas is a dense desktop operations tool. It should feel native to KétViệt products while
remaining visually identifiable as PhaseAtlas. The canonical guidance currently lives in the
Kingfruit repository under `docs/design-system/`.

## Decision

The renderer follows the KétViệt staff/operational profile:

- warm-neutral canvas and white or ink surfaces;
- indigo reserved for primary actions, active state, and focus;
- Inter typography, compact information density, and a 228-pixel desktop sidebar;
- 4/6/8/12-pixel radii, restrained shadows, WCAG AA contrast, and reduced-motion support;
- light and dark themes without decorative gradients in operational content.

PhaseAtlas owns a separate mark: four modular phase facets around an atlas compass. The mark uses
the KétViệt indigo and deep-ink family without copying the KétViệt `K` silhouette. The application
asset is `apps/ui/static/assets/phaseatlas-logo-mark.png`; the KétViệt name appears only as an
endorsement in the lockup.

## Consequences

New renderer components must use the local semantic tokens before introducing raw colors or
shadows. When the upstream KétViệt design system changes, PhaseAtlas should review and intentionally
snapshot compatible changes instead of importing Kingfruit runtime code.
