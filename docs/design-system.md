# Interface and source conventions

Helium Synk uses the blue, navy and mint palette of its [logo](branding.md). All current pages share one dark-only theme: the WXT options dashboard, enrollment/recovery forms and temporary restoration page. Future web pages should reuse these tokens and components.

## Shared theme

`extension/styles/theme.css` defines Tailwind CSS 4 tokens and local fonts. `extension/wxt.config.ts` loads the official Tailwind Vite plugin. Both HTML entrypoints declare `class="dark"`; there is no light theme or appearance switch.

| Token                | Value     | Purpose                         |
| -------------------- | --------- | ------------------------------- |
| Background           | `#080e20` | Dark navy canvas                |
| Card                 | `#101b33` | Panels and confirmations        |
| Foreground           | `#eef3ff` | Main text                       |
| Muted foreground     | `#9daecc` | Supporting text                 |
| Primary / focus ring | `#4ae5cc` | Mint actions and keyboard focus |
| Brand blue           | `#5274fa` | Structure and status accents    |
| Brand navy           | `#0d1b47` | Logo-related background accents |
| Border               | `#283b5e` | Square outlines and dividers    |
| Destructive          | `#ff8e9b` | Errors and removal warnings     |

All radius tokens, including `xs` through `4xl`, resolve to zero. Use square cards, controls, badges, tabs and dialogs. The recognizable source logo retains its existing artwork. Typography is Manrope for interface text and IBM Plex Mono for metadata. Font files and their OFL license notices ship inside the extension; pages make no font requests to an external service.

## Components

`extension/components/ui` contains shadcn/ui components installed through the official CLI, using Radix primitives and the New York style. The registry settings are in `extension/components.json`. Controls, Field groups/labels/descriptions/errors, Card headers/content/footers, Item rows, Empty states, alerts, badges, tabs, checkboxes, disclosures and confirmations compose this toolkit. The options layout uses Tailwind utilities and `@apply`; the restoration page uses the same theme and cards/buttons directly.

Use `@/lib/utils` for `cn` (`clsx` and `tailwind-merge`). Keep async request/error handling in the existing panels. Confirmation dialogs use accessible titles/descriptions, move initial focus to cancellation and preserve pending/error/retry behavior. Native selects use explicit labels and IDs. Disclosures use `type="button"` so opening recovery settings cannot submit enrollment.

## Spacing and composition

Use a `Field` for each label/control pair and `FieldGroup` for a form. Place helper text in `FieldDescription`, associate it through `aria-describedby`, and put field failures in `FieldError`. Use horizontal Fields for checkboxes. Do not wrap inputs inside a label or add global label/form-button margins. The shared field gap is 8 px, grouped fields use 24 px, content/action groups use 12–16 px, and standard inputs/selects/buttons are 40 px tall. Adjacent controls share a top edge; helper text stays below its own control.

Compose panels with Card headers, titles, descriptions, content and footers. Use Item content/actions for linked setup/settings/device rows and Button `asChild` for action links. Keep semantic headings and native labels. Custom Tailwind layout is appropriate for navigation, responsive grids and domain-specific timelines; avoid recreating available primitives. Check both closed and expanded disclosures, long titles/URLs and the 390 px layout.

## Page architecture

The options UI uses separate TanStack Router views for Home, Bookmarks, Sessions, History, Devices and Settings. Setup and advanced settings have focused routes; only the active page mounts. Use the shared status provider and existing background requests. Keep secrets out of route state, preserve durable pairing retry and keep secondary help in disclosures. See [the UX contract](extension-ux.md) for routes and verification boundaries.

## TypeScript aliases

Use `@/…` for extension source imports, for example:

```ts
import { Button } from '@/components/ui/button';
import type { Status } from '@/lib/messages';
import '@/styles/theme.css';
```

The extension TypeScript config maps `@/*` to its source root. The workspace TypeScript config and both Vitest configs map it to `extension/`; WXT/Vite resolves `@` to that same directory. Keep those mappings aligned. Shared core imports continue to use the workspace package name `@helium-synk/core`. Relative CSS `@import`/`@source` paths follow CSS resolution rules.

Setup references: [shadcn Vite installation](https://ui.shadcn.com/docs/installation/vite), [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite), and [WXT Vite configuration](https://wxt.dev/guide/essentials/config/vite).
