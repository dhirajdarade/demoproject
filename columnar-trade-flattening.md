# Columnar Trade Data: Flattening Design & Implementation

## 1. Background

Trade schedule data (e.g. a Bermudan cancellable interest rate swap) is nested by
construction: a **trade** has one or more **legs**, and each **leg** has one or more
**periods**. Two different in-memory shapes of this same data came up, and the
industry-standard names for them are:

| Term (our usage) | Standard name | Shape |
|---|---|---|
| v1 | **Array of Structures (AoS)** | `legs: [{ periodNum, startDate, ... }, ...]` — a list of records |
| v2 | **Structure of Arrays (SoA)** | `periodNum: [1,2,3,...], startDate: [...], ...` — same fields, transposed into parallel arrays |

The UI receives data in **v2 (columnar / SoA)** format from the backend, across
hundreds of trades at once, and needs it in **tabular** form to bind to an
Angular grid (mat-table / ag-grid). This document describes the shared
vocabulary, the schema that describes the v2 shape generically, the two
flattening strategies implemented, and every edge case each one accounts for.

---

## 2. Terminology (division glossary)

| Term | Definition |
|---|---|
| **Grain** | The level of detail one record represents (Kimball dimensional-modeling term). Replaces the earlier ad-hoc word "tier." |
| **Header grain** | The outermost/root grain — scalar, one value per whole record (e.g. `tradeId`, `tradeType`). |
| **Leg grain** | The middle grain — one entry per leg of a trade. |
| **Leaf grain** | The innermost grain — no further children (e.g. per-period fields). |
| **Hinge field** | An array living at a given grain whose integer values say how many next-grain rows each entry at this grain owns. Generalizes `periodCounts`. Only present on non-leaf grains. |
| **Degenerate column** | A field that is a bare scalar (usually `null`) instead of an array, because that field does not apply to this particular record at all (e.g. `noticeDate` on a 2-leg vanilla swap that has no option leg). |
| **Explode** | Flattening 1 record → **N rows** (row-oriented normalization; standard SQL term, cf. `UNNEST`/`LATERAL FLATTEN`). |
| **Wide-flatten** | Flattening 1 record → **1 row**, denormalizing array entries into index-suffixed columns instead of new rows. |
| **Ragged / jagged nested columnar structure** | The overall pattern: nested grains where each grain's cardinality is described by a hinge/offset array pointing into the next grain's flat arrays. |

---

## 3. The Tier Schema

Rather than hardcoding field names, the shape of a v2 record is described
declaratively by a `TierSchema`, so the flattening functions work for any
grain structure, not just `trade → leg → period`.

```typescript
export interface TierDef {
  tierName: string;                 // e.g. "trade", "leg", "period"
  cardinality: 'scalar' | 'array';
  fields: string[];                 // top-level JSON keys belonging to this grain
  hingeField?: string;              // required on every non-leaf tier
}

export interface TierSchema {
  tiers: TierDef[];
}
```

**Confirmed schema for this data:**

```json
{
  "tiers": [
    { "tierName": "trade", "cardinality": "scalar", "fields": ["tradeId", "tradeType"] },
    {
      "tierName": "leg",
      "cardinality": "array",
      "fields": ["legs", "legDescriptions"],
      "hingeField": "periodCounts"
    },
    {
      "tierName": "period",
      "cardinality": "array",
      "fields": [
        "periodNum", "startDate", "endDate", "paymentDate", "notional",
        "rate", "resetDate", "spread",
        "noticeDate", "exerciseDate", "effectiveTerminationDate"
      ]
    }
  ]
}
```

Adding a new grain (e.g. a `portfolio` tier above `trade`, or a grain below
`period`) is a **config change** — add one more `TierDef` — not a code change,
since the flattening functions recurse generically over `tiers`.

---

## 4. Functions implemented

All in `columnar-to-tabular.ts`.

| Function | Direction | Purpose |
|---|---|---|
| `explodeRecord(record, schema)` | 1 record → N rows | Core row-explosion logic for a single trade |
| `explodeRecordArray(records, schema, opts)` | N records → flattened row array | Batch wrapper; optionally runs `warnIfSchemaViolated` first |
| `flattenRecord(record, schema)` | 1 record → 1 wide row | Core wide-flatten logic for a single trade |
| `flattenRecordArray(records, schema)` | N records → N wide rows | Batch wrapper |
| `unionColumns(rows)` | post-flatten | Computes the union of keys across ragged wide-flattened rows, in first-seen order |
| `pruneFullyNullFields(records, schema)` | pre-explode | Returns a schema copy with fields dropped if they're `null`/absent across **every** record in the batch |
| `warnIfSchemaViolated(record, schema)` | dev-mode check | Logs (never throws) if a record's fields diverge from the schema, or if a hinge tier's sums don't match the next tier's array length |

### 4.1 `explodeRecord` / `explodeRecordArray` — row explosion

Walks tiers top-down. Scalar tiers merge into an accumulating row context.
Array tiers loop over their own entry count (read from their own field
array's length, or from the parent's hinge value) and recurse into the next
tier using a **per-tier running offset** — this is what correctly slices the
flat leaf arrays into the right leg-sized segments without ever needing to
know the boundaries in advance.

```typescript
const rows = explodeRecordArray(trades, TRADE_TIER_SCHEMA);
// -> one row per period, across all legs, across all trades
```

### 4.2 `flattenRecord` / `flattenRecordArray` — wide flatten

Same recursive walk, but instead of pushing a new row per leaf entry, it
writes into a single accumulating object with **index-suffixed keys**
(1-based, human-friendly):

```
legs_1, legs_2, legs_3
legDescriptions_1, legDescriptions_2, legDescriptions_3
periodNum_1_1, periodNum_1_2, periodNum_1_3,   // leg 1, periods 1-3
periodNum_2_1, periodNum_2_2, periodNum_2_3,   // leg 2, periods 1-3
periodNum_3_1, periodNum_3_2, periodNum_3_3    // leg 3, periods 1-3
```

### 4.3 `unionColumns`

Needed **only** for wide-flattened output. Because different trades can have
different leg/period counts, `flattenRecord` rows do **not** share an
identical key set across a batch (a 2-leg trade simply has no `legs_3` key
at all — not `null`, absent). Deriving grid columns from a single row (e.g.
`rows[0]`) is order-dependent and can silently hide another trade's data.
`unionColumns` scans every row and returns the full key superset.

### 4.4 `pruneFullyNullFields`

Runs **before** exploding, on the raw columnar arrays, not the flattened
output. If a field is `null`/absent for **every trade in the batch**, it's
dropped from the schema entirely, so the flattener never allocates or writes
that key. Cheaper than a post-hoc "find and hide empty columns" pass, since
it avoids the property-write cost (which dominates over reads in V8) for a
column that's going to be discarded anyway.

---

## 5. Special scenarios accounted for

| # | Scenario | How it's handled |
|---|---|---|
| 1 | **Different leg counts per trade** (3-leg Bermudan vs. 2-leg vanilla swap) | Leg-tier entry count is read from the trade's own `legs.length`, not assumed fixed; `periodCounts` (the hinge) drives correct offsetting into the leaf arrays regardless of how many legs exist. |
| 2 | **A leaf-grain field that doesn't apply to a whole trade** (e.g. `noticeDate` on a 2-leg swap with no option leg) | Represented as a **scalar `null`**, not an array of nulls. `readFieldAt` checks `Array.isArray()` before indexing; a scalar (including `null`) is broadcast unchanged to every row/column that would otherwise have indexed into it. |
| 3 | **Confirmed backend contract: identical field names/order across all trades** | `explodeRecordArray` relies on this to avoid re-deriving columns per trade — but the contract is scoped to *presence of keys*, not to whether every trade *uses* every leg (see #1). `warnIfSchemaViolated` logs (doesn't throw) if a future trade violates it. |
| 4 | **A column that's `null` for every row of one trade but has real data in others** | Not pruned — `pruneFullyNullFields` only drops a field if it's null/absent across **the entire batch**, since per-trade pruning would reintroduce inconsistent row keys (the same bug the backend contract in #3 exists to prevent). |
| 5 | **A column that's `null` across the *entire* batch** (e.g. no trade currently uses fixed-rate legs) | `pruneFullyNullFields`, run pre-explode, removes it from the schema so it never appears as a dead, all-blank column in the grid. |
| 6 | **Hinge fields (`periodCounts`) must never be pruned**, even if structurally trivial | `pruneFullyNullFields` explicitly excludes `tier.hingeField` from the null-check — it's structural (drives row counts), not a data signal. |
| 7 | **Hinge-sum / next-tier-length mismatch** (schema contract silently broken) | `warnIfSchemaViolated` sums each hinge array and compares it to the actual length of the next tier's arrays, logging a warning — never throws, so a bad batch doesn't crash the UI, but the mismatch is visible in logs. |
| 8 | **Missing declared field on a specific trade** | `warnIfSchemaViolated` checks `f in record` for every schema-declared field and warns per-trade if absent. |
| 9 | **Wide-flatten produces a ragged (non-uniform) key set across trades** | `unionColumns` computes the superset across all wide rows; the grid must render missing keys as blank, not treat them as errors. This is inherent to wide-flattening ragged data and cannot be schema-contracted away like row-explosion can. |
| 10 | **Leg-level metadata (`legDescriptions`) is not a per-period column** | Kept out of the leaf tier's `fields`; attached once per leg-block during row explosion (as `legDescription` per row) rather than incorrectly sliced/zipped against period-indexed data. |
| 11 | **Arbitrary N-tier depth** (not hardcoded to exactly 3 tiers) | Both `explodeRecord` and `flattenRecord` recurse generically over `schema.tiers`; adding a 4th grain (e.g. `portfolio` above `trade`) requires only one more `TierDef`, no code change. |
| 12 | **Performance at scale (1000 trades)** | Benchmarked directly (see §6) rather than assumed — row-explosion is materially cheaper than wide-flatten + union at realistic period counts, and `devCheck` (schema validation) roughly doubles cost, so it should be gated off in production once the contract is trusted. |

---

## 6. Performance (benchmarked, not estimated)

Synthetic dataset: **1000 trades**, 3 legs each, 20/30/40 periods per leg
(90 periods/trade → **90,000 total leaf rows**).

| Path | Cost |
|---|---|
| `explodeRecordArray`, dev checks **on** | ~115 ms avg (warm) |
| `explodeRecordArray`, dev checks **off** | ~64 ms avg (warm) |
| `flattenRecordArray` (wide, ~270 cols/trade) | ~748 ms |
| `unionColumns` over the wide output | ~75–120 ms |
| Heap used (explode path) | ~81 MB |

**Takeaways:**
- Row-explosion is ~10× cheaper than wide-flatten at this period-count scale, because wide-flatten's cost is proportional to **column width** (property writes with dynamic keys), while explosion's cost is proportional to **row count** with a fixed, small key set per row.
- `devCheck`/`warnIfSchemaViolated` roughly doubles explosion cost — appropriate for development, should be disabled in production once the backend contract (identical field names/order) is trusted.
- None of these costs are a per-render concern — they should run once when a batch arrives (in a service, before the component/grid binds to it), not inside a template getter or change-detection cycle.
- The real rendering bottleneck at 90K+ rows is the grid's own DOM virtualization (mat-table CDK virtual scroll / ag-grid), not this flattening step.

---

## 7. Reference files

| File | Contents |
|---|---|
| `columnar-to-tabular.ts` | Full implementation: types, schema constant, `explodeRecord`/`explodeRecordArray`, `flattenRecord`/`flattenRecordArray`, `unionColumns`, `pruneFullyNullFields`, `warnIfSchemaViolated` |
| `columnar_trades_v2.json` | Two sample v2 (SoA) trades: a 3-leg Bermudan cancellable swap and a 2-leg vanilla swap (with degenerate-null option fields), used throughout for testing |
