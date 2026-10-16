# CLS playbook

- Evidence: PSI layout-shift culprits (`layout-shifts` / CLS culprits insight), `unsized-images`, `fetch_html` images and
  iframes without width/height, late-injected banners, font-display.

## Common causes and fixes
- Images/video/iframes/ads without dimensions → set `width`/`height` or CSS `aspect-ratio`; reserve ad slot `min-height`.
- Content injected above existing content (cookie banners, promo bars, "app install" banners, async embeds) →
  reserve space, overlay instead of push, or render server-side.
- Web fonts swapping with different metrics → `size-adjust`/`ascent-override` fallback fonts, `font-display: optional`,
  preload fonts, `next/font` style tooling.
- Animations of layout properties (`top`, `height`, `margin`) → use `transform`/`opacity`.
- Back/forward cache ineligibility can inflate field CLS/LCP — mention if navigation types show many back_forward visits.

## Field CLS attribution
- `get_rum` → `cls.topShiftElements`: element, share of bad visits, `whenShifted` (loadState: loading / dom-interactive /
  dom-content-loaded / complete). Mostly `complete` = shifts after load (scroll, ads, banners, late widgets).
- `simulate_session` → `cls.byStep` + `topSources`: which step shifts which element (load / post-load-idle / consent /
  scroll / menu / widgets) and by how many px. Shifts within 500 ms of a tap/click are excluded (as in Chrome).
- Shift sources are the elements that **moved**; the cause is what was inserted/resized above them. Use the session's
  `likelyCauses` (DOM inserted/resized right before the shift) to name the culprit (cookie bar, ad slot, promo, embed).
- Match them: the element that dominates RUM and also shifts in the session is the root cause (high confidence).

