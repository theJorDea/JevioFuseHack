---
name: make-interfaces-feel-better
description: Design engineering principles for polished, ergonomic user interfaces.
whenToUse: When building or reviewing UI components, visual states, interaction details, animations, typography, spacing, shadows, or touch targets.
type: prompt
---

# Make interfaces feel better

Apply the smallest visual and interaction details that make the interface feel intentional.

- Prefer optical alignment over mathematically centered but visually off icons and labels.
- Use concentric border radii for nested surfaces: the outer radius should account for the inner radius and padding.
- Use subtle layered shadows where depth is useful; avoid heavy borders between related surfaces.
- Give interactive controls a minimum 40 by 40 pixel hit area without overlapping neighboring controls.
- Use exact transition properties instead of `transition: all`. Prefer interruptible transitions for hover, press, and state changes.
- Keep motion restrained: make entrances slightly stronger than exits, and use `scale(0.96)` for a tactile press state when motion is appropriate.
- Use tabular numbers for values that update in place. Make headings and body copy wrap cleanly.
- Keep icon state changes contextual with opacity, scale, or blur rather than abrupt swaps.
- Check text wrapping, truncation, focus states, keyboard navigation, loading, empty, error, and disabled states.
- Keep text inside controls at every supported viewport. Do not use decorative visual effects that make work surfaces harder to scan.

For UI review results, group concrete changes by principle and use a Markdown table with `Before` and `After` columns. Include exact files and properties when they are not obvious.

Source: jakubkrehel/make-interfaces-feel-better (MIT), adapted as a bundled Jevio skill.
