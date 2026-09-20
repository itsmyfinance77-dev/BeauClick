# Font files — provenance and open items

These three files came from the approved design snapshot `BeauClick V3 (5)`
(2026-09-12), converted from TTF to WOFF2 without resubsetting:

| File | Source | Size |
| --- | --- | --- |
| `Vazir-Variable.woff2` | `fonts/Vazir-Variable.ttf` | 41KB (from 88KB) |
| `Anjoman-ExtraBold.woff2` | `fonts/Anjoman-ExtraBold.ttf` | 36KB (from 88KB) |
| `Anjoman-Black.woff2` | `fonts/Anjoman-Black.ttf` | 37KB (from 90KB) |

Peyda ships in the snapshot and is deliberately **not** here:
`V3_DESIGN_SYSTEM.md` §3 says two faces and no third.

## Two things this directory does not settle

**1. Self-host or CDN is still a formal business decision.**
`34_TYPOGRAPHY_VAZIRMATN.md` classifies it `BUSINESS DECISION REQUIRED` and
recommends self-hosting, because the CDN route depends on that origin being
reachable from inside Iran and on the unmade hosting-region decision. Self
hosting is implemented here because it is the recommendation and because it
works either way; if the formal decision goes to a CDN, only `fonts.ts`
changes and nothing else in the product does.

**2. These are the design workshop's development files, not production
assets.** The same document says so in as many words: the production subset
(Latin + Arabic/Persian) must be taken from the official Vazirmatn release
with its licence stated, not from these sample files. Nobody has verified the
licence of the Anjoman cuts at all.

Until that is done, treat this directory as unblocking the design language
rather than as shipping-ready. Both items are tracked.
