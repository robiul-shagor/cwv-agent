# Locating issues in source code (only when code tools are available)

Budget: ~2-4 code tool calls per finding. Start with `list_files` (path ".", a glob like "**/*.{tsx,jsx,vue,svelte,astro,php,liquid}")
only if the structure is unknown.

## Turn evidence into search terms (most specific first)
- **Selectors** (`div.homeHeader__content > div.hero-title-main > span.w`): search each distinctive class/id on its own
  (`homeHeader__content`, `hero-title-main`). Skip generic ones (`container`, `row`, `w`, `text`). CSS-module / BEM names
  appear in JSX as `styles.homeHeader__content` or `className="homeHeader__content"`; hashed names (`Hero_title__a1b2c`)
  → search the part before `__`.
- **Images / fonts**: search the file name without hash/size suffix (`hero-banner` from `/_next/image?url=%2Fimg%2Fhero-banner.webp`).
- **Scripts / stylesheets**: third-party → search the domain or id (`googletagmanager`, `G-XXXX`, `gtag`); first-party bundles
  are hashed → search what loads them (`<Script`, `next/script`, `wp_enqueue_script`, `<link rel="stylesheet"`).
- **Fonts**: `next/font`, `@font-face`, `fonts.googleapis`, `font-display`.
- **Visible text** from the LCP element snippet (headline copy) is a reliable anchor.
- Then read 20-60 lines around the best match to confirm the cause and take the exact line number.

## Where things usually live
- **Next.js**: `app/layout.tsx` (fonts, global scripts, `<head>`), `app/**/page.tsx`, `pages/_app.tsx`, `pages/_document.tsx`,
  `components/**`; images via `next/image` (`priority`, `sizes`, `fetchPriority`), scripts via `next/script` (`strategy`).
- **React SPA / Vite**: `index.html`, `src/main.*`, `src/App.*`, `src/components/**`.
- **Nuxt / Vue**: `nuxt.config.*`, `app.vue`, `layouts/`, `pages/`, `components/`.
- **WordPress theme**: `functions.php` (`wp_enqueue_*`, `add_action('wp_head')`), `header.php`, `template-parts/`,
  `style.css`; page builders store markup in the DB (then the fix is `platform`).
- **Shopify theme**: `layout/theme.liquid`, `sections/*.liquid`, `snippets/*.liquid`, `assets/`.
- **CSS causes** (CLS from animations, render-blocking imports): `*.css`, `*.scss`, `*.module.css`, `tailwind.config.*`.

## Fix suggestions
- Quote the actual prop/attribute to change and the target value (e.g. `<Image priority sizes="100vw" />`,
  `strategy="lazyOnload"`, `font-display: optional`, `aspect-ratio: 16 / 9`, `min-height` reservation).
- `patch`: minimal unified diff (`--- a/path`, `+++ b/path`, `@@` hunks) against the lines you read. One file per finding.
