---
name: design-taste
description: Anti-slop frontend taste for landings, portfolios, and marketing UI — variance, motion, density dials, brief inference, hard ban on generic AI aesthetics.
whenToUse: When creating or redesigning a landing page, portfolio, marketing site, or premium product marketing surface that must not look like default LLM UI slop.
type: prompt
---

# Design taste (anti-slop)

Portable guidance distilled for Fuse from the open-source [taste-skill](https://github.com/Leonxlnx/taste-skill) project (MIT). Use for **landings / portfolios / marketing redesigns**, not dense admin dashboards or multi-step product wizards (use other skills for those).

## 0. Brief inference first

Before code, write one line:

**Reading this as:** `<page kind>` for `<audience>`, vibe `<…>`, leaning `<system or aesthetic>`.

Signals: page kind (SaaS landing, portfolio, redesign…), vibe words, references, audience, existing brand assets, quiet constraints (a11y / regulated / kids).

If the design read genuinely forks, ask **exactly one** clarifying question. Otherwise declare the read and proceed.

### Anti-default discipline

Do **not** default to: purple AI gradients, centered hero over dark mesh, three equal feature cards, generic glass everywhere, infinite micro-animations, Inter + slate-900. Reach past LLM defaults deliberately.

## 1. Three dials (1–10)

Set after the design read (conversational overrides ok):

| Dial | Low | High | Default baseline |
| --- | --- | --- | --- |
| **DESIGN_VARIANCE** | centered / clean | asymmetric / experimental | 7–8 for landings |
| **MOTION_INTENSITY** | hover only | scroll / cinematic | 5–6 |
| **VISUAL_DENSITY** | airy / gallery | dense / cockpit | 3–4 |

Quick map:

- minimalist / Linear / calm → variance 5–6, motion 3–4, density 2–3  
- premium / Apple-y → 7–8 / 5–7 / 3–4  
- playful / Awwwards → 9–10 / 8–10 / 3–4  
- trust-first / public sector → 3–4 / 2–3 / 4–5  

## 2. Foundation honesty

- Prefer **one real design system / stack already in the repo**. Do not invent package APIs.
- If the project already has Tailwind / tokens / components, reuse them.
- One system per project — do not mix Material + Fluent + shadcn casually.
- Aesthetic trends (glass, bento, brutalism) are CSS directions, not fake “official packages”.

## 3. Layout & type (taste bar)

- One strong visual direction: type scale, spacing rhythm, surface treatment, accent, hierarchy.
- Prefer a few strong sections over a grid of identical cards.
- Asymmetry and overlap only when variance dial is high; otherwise keep calm structure.
- Readable line lengths, real content, believable empty/loading/error states.
- Hard ban on decorative em-dashes as a “premium” typography crutch in marketing copy if the brief is clean/minimal.

## 4. Motion

- Purposeful only. Respect `prefers-reduced-motion`.
- Animate transform/opacity; avoid layout thrash.
- Entrances slightly stronger than exits; interruptible hovers.
- High motion dial ≠ endless loops on every element.

## 5. Pre-flight before “done”

- [ ] Design read stated  
- [ ] Dials match brief  
- [ ] No default AI aesthetic leftovers  
- [ ] Stack matches the repo  
- [ ] Focus, keyboard, mobile, reduced-motion considered  
- [ ] No placeholder lorem / broken images / dead CTAs  

## 6. Redesigns

Audit first: what to keep (brand, trust patterns), what to replace (spacing, hierarchy, motion). Do not rewrite working product chrome when the request is a marketing surface only.

---

Credit: patterns inspired by Leonxlnx/taste-skill (MIT). Adapted for Jevio Fuse Agent Skills.
