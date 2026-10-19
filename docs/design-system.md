# TradeD design system (Graphite)

Calm, precise, finance-first. Principles borrowed from Apple's apps, Zerodha Kite and Dhan; no brand assets copied.

## Tokens
Defined in `src/app/tokens.css` and mirrored in `src/lib/color/appearance.ts` (`LIGHT_TOKENS`, `DARK_TOKENS`, `CHART_TOKENS`). Change both together.

| Role | Light | Dark |
|---|---|---|
| Background | `#F5F5F7` | `#0A0A0B` |
| Panel / elevated / overlay | `#FFFFFF` | `#111113` / `#18181B` / `#1F1F23` |
| Text / secondary / muted | `#1C1C1E` / `#3C3C43` / `#6E6E73` | `#F5F5F7` / `#C7C7CC` / `#8E8E93` |
| Accent (primary) | `#1F5FEA` | `#4E86FF` |
| Profit / loss (text) | `#0B8457` / `#D92D3A` | `#2EBD85` / `#F6465D` |
| Candles up / down | `#0E9F6E` / `#E5484D` | `#2EBD85` / `#F6465D` |
| Hairline border | `#E3E3E8` | `#26262B` |

Light-theme text colours meet WCAG AA (4.5:1) on white.

## Typography
- Inter (variable, optical sizing) for everything, including numbers.
- Numbers: `.num` = UI face with `tabular-nums slashed-zero`. Monospace only for ids and code.
- Scale: micro 11, data 12.5, dense 13.5, body 14, title 16, section 20, page 28, hero 30. Headings track -0.02em.
- Sentence case. No upper-case badges.

## Shape and depth
- Radii: input 10, md 12, card 16, lg 18, sheet 22, pill.
- Separate with spacing and surface tone first; hairlines only for tables, inputs and dividers. Cards use `shadow-e1`, `shadow-e2` on hover.

## Icons
- lucide-react, stroke 1.6 everywhere (set globally on `svg.lucide`). Sizes 16 inline, 18 buttons, 20 navigation.

## Status
- One status line per object: coloured dot + short text (for example "● Ready to trade"), details in a tooltip.
- Badges are tinted pills without outlines, sentence case.
- LIVE (loss/amber) and DEMO (violet) cues must always stay unmistakable.

## Motion
- `--ease-ui: cubic-bezier(.2,.8,.2,1)`, `--ease-spring: cubic-bezier(.34,1.56,.64,1)`; 120 / 180 / 240 ms.
- Respect `prefers-reduced-motion` (durations drop to 0).

## Navigation
- Rail groups: Trade (Home, Chart, Options, Accounts) · Portfolio (Positions, Orders, Portfolio, Money) · Discover (Markets, Alerts, Prediction) · Admin.
- Translucent top bar (`backdrop-blur-xl`).
