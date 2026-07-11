---
name: frontend-interface
description: Build polished, accessible web interfaces while choosing the right implementation primitives for the existing project stack.
whenToUse: When creating or substantially changing a website, landing page, dashboard, design system, or frontend interaction.
type: prompt
---

# Frontend interface implementation

Build a real, coherent interface that fits the repository. Treat the existing stack and its installed dependencies as constraints, not suggestions.

## Inspect the stack first

Before writing UI code, inspect `package.json`, the app entry points, the styling setup, and any existing component directories. Identify:

- whether this is static HTML/CSS, React, Next.js, Vue, Svelte, or another framework;
- whether Tailwind, CSS modules, a design-token file, or an existing component library is already installed;
- the actual build, lint, test, and dev commands.

Never put JSX in a plain `.html` file: use `class` in HTML and `className` only in JSX/TSX. Keep imports and component paths consistent with the detected framework.

## Choose the UI primitives deliberately

- In a React/Next.js project that already uses Tailwind and shadcn/ui, inspect `components.json`, existing `components/ui/*`, and installed Radix dependencies. Reuse the existing shadcn primitives and conventions before creating new ones.
- If the project is React/Next.js + Tailwind but shadcn/ui is not installed, do not silently install it. First build with the existing primitives; add a dependency only when the user requested it or the implementation plan explicitly includes it and the normal approval gate allows the package command.
- In static HTML or a non-React project, do not add shadcn imports. Use semantic HTML, the existing CSS approach, and small local components/patterns appropriate to that stack.
- Do not invent package APIs or import paths. Verify a component exists before using it.

## Design and interaction bar

- For landings, portfolios, and marketing redesigns, also load the **design-taste** skill and follow its brief-inference + three dials (variance / motion / density). Avoid default LLM aesthetics (purple mesh heroes, three equal cards, Inter-on-slate).
- Establish one clear visual direction: type scale, spacing rhythm, surface treatment, accent color, and content hierarchy.
- Prefer a small set of strong sections over a generic collection of cards. Use generous space and large type when the request calls for a premium or editorial feel, but preserve readable line lengths and responsive behavior.
- Make interactive elements semantic and keyboard accessible. Include visible focus states, meaningful labels, disabled/error states, and sensible mobile layouts.
- Keep motion purposeful and restrained. Respect `prefers-reduced-motion`, avoid animating layout unnecessarily, and use exact transition properties.
- Use real content and believable states. Avoid placeholder copy, broken image URLs, and dead buttons when the request implies a working flow.

## Verify before finishing

Run the repository's relevant checks and inspect the rendered structure through the available local tools. Confirm that the selected framework actually builds, that responsive breakpoints do not overflow, and that the final report names the files changed and checks run.
