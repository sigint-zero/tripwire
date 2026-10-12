# Rule preview

The small chart and readout that stands for a rule wherever rules are
listed: a row or card on the Rules page, a contract's rules, and a
pinned card on the Overview. It answers, at a glance and without
opening the rule, three questions: what is watched, where the limit is,
and how close the value is to it. `RULES.md` places the lists and owns
the full chart on a rule's page; `OVERVIEW.md` owns the pinned cards;
this spec owns what the preview draws and the one read that feeds it.

It replaced a bare line of the rule's first recorded read and one
number, which had no limit, no axis and no label
(`components/RulePreview.tsx`, `lib/preview.ts`, `lib/overlays.ts`).

## Terms

| Term | Meaning |
|-|-|
| preview | the compact chart and its legend for one rule, in a list or a card |
| primary series | the rule's first recorded read (`RULES.md`, Which series), the line every preview draws |
| limit | what the primary series is compared with: a fixed number (a threshold), another recorded read, a recorded metric of a read (a moving average, a TWAP, the all-time high), or a limit worked out over a window (`RULES.md`, Overlays) |
| trip side | the side of a limit on which the rule trips: below, above, or neither for `eq` and `ne` |
| headroom | how far the primary series' latest value is from its limit, as a fraction of the limit, positive on the safe side |

## What a preview shows

From top to bottom, in a row (chart on the right, 260 px wide, 72 px
tall) and in a card (chart across the foot, full width, 96 px tall):

1. **Status pill.** The rule's status from `RULES.md`, in its words,
   always shown, a holding rule included: Holding (green), Tripped (red,
   with the open count), Error (amber), Warming up (dim amber), Off
   (grey). The words never change; only the colour is new.
2. **Action pill.** What a trip does, short: Notify, Pauses contract,
   Pauses `withdraw(uint256)`, Calls `pause()`. Severity stays the
   icon it is now.
3. **The line.** The primary series over the last 24 hours, its
   minimum-to-maximum range faint behind it as now, ending in a dot at
   the latest value.
4. **The limit**, drawn as `RULES.md` Overlays draws it on the full
   chart, using the same code:
   - a threshold: a dashed red line at the number, and the trip side
     shaded faint red across the chart;
   - another read: that read's line, dashed, with the trip side of it
     shaded;
   - a deviation band: the centre dashed, and the band shaded faint
     green around it, on the sides the rule states;
   - a windowed or age limit: the moving limit `RULES.md` works out,
     dashed.
5. **Axes.** The value range at the top and bottom edges, and the
   limit's value at its line, in the display scale; "−24h" at the left (or where the series starts, "−3h", when it holds
less than a day, as the full chart does)
   and "now" at the right. No grid.
6. **Legend**, one line under the chart:
   `totalAssets() · Test vault  100.2  ·  trips below 50  ·  +100.4%`.
   It gives the read and its contract, the latest value, the limit in
   words, and the headroom.

**Colour follows the value.** The line, the dot and the headroom are
green while the latest value is on the safe side. They are amber once
the headroom is under 10%, or for a band once the deviation passes 60%
of the band's width. They turn red once the latest value is on the trip
side. This is per value, not per status: a rule tripped by its event
or by another term of an `and` keeps a green line, and its status pill
says Tripped.

**Range.** The vertical range covers the line and the limit, padded by
12% each way, so a flat series sits in the middle with its limit in
view instead of lying along an edge. When the limit is far from the
values, more than 20 ranges away, the range covers the values alone and
the legend names the limit with an arrow toward it, so the line is not
pressed flat.

## When there is no line

| Rule | Preview |
|-|-|
| event-triggered, no recorded read | no chart; the event and its last firing: "Fires on each Transfer event · last 3h ago", or "· not yet" |
| no recorded series (only non-numeric reads) | "Nothing recorded to chart", with the rule's sentence above as now |
| warming up | the line from where its data starts; the status pill says Warming up, and the legend says how long is left when the rule's check knows |
| off | the line up to when it was switched off, grey |
| a limit that cannot be drawn (arithmetic on both sides, several terms) | the line alone and no headroom; the rule's sentence beside the preview says the condition |

A rule with several drawable limits (an `or` of two thresholds) draws
them all and gives the headroom of the nearest.

## Scale

Values show in the rule's display scale (`RULES.md`, Display scale).
When a rule has none set, the preview uses the `decimals()` of the
contract its first read reads, read once through the engine by the
server and kept while it runs. The legend then says "auto, 18
decimals", so the scale is never applied silently. The rule's page uses
the same scale for its readout and full chart. A number format set on
the rule's page overrides it; "raw" is kept as 0 decimals. Values the
rule computes from several reads stay raw, as on the full chart.

Numbers show compact once scaled (100.2, 3,417.5, 1.2M, 4.8B) and as
the mantissa × 10ⁿ the dashboard uses elsewhere when raw. The axis
labels keep enough digits that the top and bottom of a narrow range
read differently (5.343M and 5.284M, not 5.3M twice).

## The read

One request for all the previews on a page, which replaced
`/sparklines`:

`GET /previews?rules=1,2,3&window=24h`, at most 64 rules (the list asks
in batches of 64); `window` is `1h`, `24h` or `7d`.

```json
[
  {
    "ruleId": "12",
    "series": [
      { "id": "40", "call": { "address": "0x…", "function": "totalAssets()", "args": [], "returns": null }, "metric": null, "windowSeconds": null, "role": "read" }
    ],
    "buckets": { "40": [{ "start": "…", "first": "…", "last": "…", "min": "…", "max": "…", "count": 12 }] },
    "latest": { "40": { "value": "100200000000000000000", "blockNumber": 26172427, "blockTime": "…" } },
    "decimals": { "0x…": 18 },
    "lastFired": { "blockNumber": 26170001, "blockTime": "…" }
  }
]
```

- `series` is the rule's series as `/rules/:id/series` returns them,
  the first three: its reads first, which is where a limit's second
  read sits.
- `buckets` holds 48 per series, as `/sparklines` does now.
- `latest` comes from the newest point, so the dot and the headroom
  use the exact last value and not a bucket's.
- `decimals` lists, for each contract read, what `decimals()` returned,
  or nothing when the contract has none.
- `lastFired` is the newest violation of kind tripped, for event rules;
  it comes from the same bounded query that works out status.

The browser works out the limits and headroom from the rule document
it already holds and these series, with the code the full chart uses
(`lib/overlays.ts`), so a preview and its rule's chart never disagree.
The server reads every series' buckets in one bounded query: 64 rules
× 3 series × 48 buckets stays under the bucket read's 10,000 rows.

## Live

The previews refresh every 60 seconds, as sparklines do now. They also
refresh when `LIVE-UPDATES.md` announces a violation or a rule change
for a rule on the page, so a value that just crossed its limit turns
red without waiting.

## Open questions

1. Hover on a preview (value and time under the pointer) is left out,
   since the rule's page has it. Adding it costs a small tooltip per
   preview.

## Decisions

| # | Decision | Recommendation and reason |
|-|-|-|
| RP1 | Where limits are worked out | In the browser, with the full chart's code moved to one module. The server would need a second copy of the document walk, and two copies drift; the browser already holds every rule document |
| RP2 | Colour by value or by status | By value, with the status in its own pill. A rule tripped by its event or by another term would otherwise paint a healthy line red, and a holding rule one block from its limit would look as safe as one far away |
| RP3 | One read per page | `/previews` for up to 64 rules at a time. The list must cost a fixed number of requests whatever its length (`RULES.md`, RL5), and 64 × 3 × 48 rows fits the bucket read's cap |
| RP4 | Scale | The rule's own scale first; the contract's `decimals()` as a labelled default, chosen over only suggesting it. Raw 10²⁰ numbers were the main reason the previews read as noise; an oracle with its own decimals on a token contract is set once on its rule's page |
| RP5 | Padding and far limits | Pad 12% and include the limit, unless it is far away. A limit at 0 under values near 10²⁰ would otherwise flatten the line into the top edge, as the full chart does |
| RP6 | Rows per read | The bucket read keeps its 10,000 rows, chosen over batches of six rules |

## Checkpoint

The previews are done when, provably and repeatably:

1. A threshold rule, a rule comparing two reads, a deviation band, a
   windowed-drop rule and an age rule each draw their limit in the
   preview exactly where the rule page's full chart draws it, at the
   same value.
2. A value crossing its limit turns the line, dot and headroom red
   within one refresh; within 10% it is amber; a rule tripped only by
   its event keeps a green line and a red pill.
3. A flat series shows mid-chart with its limit visible; a limit 30
   ranges away is named with an arrow and leaves the line readable.
4. An event rule shows its event and last firing; a rule with nothing
   recorded says so; a warming rule says Warming up.
5. A token contract with `decimals()` shows 100.2 with "auto · 18
   decimals"; setting raw on the rule's page shows the raw number.
6. A list of 200 rules loads every preview in four requests.
7. A threshold inside `not` shades the side that trips: below for
   `not (x ≥ 5)`.
