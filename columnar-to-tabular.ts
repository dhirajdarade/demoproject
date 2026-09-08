/**
 * Generic, schema-driven flattener for ragged nested Structure-of-Arrays
 * (SoA) records — e.g. trade -> leg -> period — into a flat tabular row
 * array suitable for mat-table / ag-grid / any Angular data-source binding.
 *
 * Instead of hardcoding field names, the shape of the record is described
 * by a TierSchema. Each tier is one "grain" (header grain, leg grain, leaf
 * grain, ...). explodeRecordArray() walks the schema generically, so adding a
 * new grain (e.g. inserting a "portfolio" tier above "trade", or a new
 * grain below "leg") is a config change, not a code change.
 *
 * TERMINOLOGY (see team glossary):
 *   - grain        : level of detail one record represents (was "tier")
 *   - header grain : root/top grain (scalar, one value per whole record)
 *   - leaf grain    : innermost grain, no further children
 *   - hinge field  : offset/cardinality array on a grain that says how many
 *                    child-grain rows each entry at this grain owns
 *   - degenerate column : a field that's a bare scalar (usually null)
 *                    instead of an array, because it doesn't apply to this
 *                    record at all (e.g. optionLeg fields on a 2-leg swap)
 */

export interface TierDef {
  /** Domain-agnostic grain label, e.g. "trade", "leg", "period". */
  tierName: string;
  /** "scalar" = one value describing the whole parent; "array" = one entry per index at this grain. */
  cardinality: 'scalar' | 'array';
  /** Field names (top-level JSON keys) that belong to this grain. */
  fields: string[];
  /**
   * Required on every non-leaf tier. Names a field — itself living at THIS
   * tier as an array — whose integer values say how many next-tier rows
   * each entry at this tier owns. Absent on the leaf (innermost) tier.
   */
  hingeField?: string;
}

export interface TierSchema {
  tiers: TierDef[];
}

/** A record conforming to a TierSchema: arbitrary top-level keys, values are scalars or arrays. */
export type SchemaRecord = Record<string, any>;

export type TabularRow = Record<string, any>;

/**
 * The confirmed schema for the trade -> leg -> period structure.
 * Swap this out (or accept a schema param) if other divisions' payloads
 * use a different grain structure.
 */
export const TRADE_TIER_SCHEMA: TierSchema = {
  tiers: [
    { tierName: 'trade', cardinality: 'scalar', fields: ['tradeId', 'tradeType'] },
    {
      tierName: 'leg',
      cardinality: 'array',
      fields: ['legs', 'legDescriptions'],
      hingeField: 'periodCounts',
    },
    {
      tierName: 'period',
      cardinality: 'array',
      fields: [
        'periodNum',
        'startDate',
        'endDate',
        'paymentDate',
        'notional',
        'rate',
        'resetDate',
        'spread',
        'noticeDate',
        'exerciseDate',
        'effectiveTerminationDate',
      ],
    },
  ],
};

/** Reads a field's value at a given global index for this tier, honoring the degenerate-scalar rule. */
function readFieldAt(record: SchemaRecord, field: string, index: number): any {
  const value = record[field];
  if (Array.isArray(value)) {
    return value[index] ?? null;
  }
  // Scalar (including bare null) => doesn't vary per-entry at this tier; broadcast as-is.
  return value ?? null;
}

/**
 * Flattens a single schema-conforming record into tabular rows.
 * Walks tiers depth-first; array-tiers consume a running per-tier offset
 * (`offsets`) so each tier's own flat arrays are read left-to-right exactly
 * once, in the same order they were originally laid out.
 */
export function explodeRecord(record: SchemaRecord, schema: TierSchema): TabularRow[] {
  const { tiers } = schema;
  const rows: TabularRow[] = [];
  const offsets = new Array(tiers.length).fill(0);

  function walkScalarTiers(tierIdx: number, context: TabularRow): void {
    if (tierIdx >= tiers.length) {
      rows.push(context);
      return;
    }
    const tier = tiers[tierIdx];
    if (tier.cardinality === 'scalar') {
      const merged: TabularRow = { ...context };
      for (const f of tier.fields) merged[f] = record[f] ?? null;
      walkScalarTiers(tierIdx + 1, merged);
    } else {
      // First array tier under a scalar (or all-scalar) ancestry: its own
      // entry count is simply the length of its own field arrays.
      const referenceField = tier.fields.find((f) => Array.isArray(record[f]));
      const entryCount = referenceField ? record[referenceField].length : 0;
      walkArrayTier(tierIdx, entryCount, context);
    }
  }

  function walkArrayTier(tierIdx: number, entryCount: number, context: TabularRow): void {
    const tier = tiers[tierIdx];
    const isLeaf = tierIdx === tiers.length - 1;
    const startOffset = offsets[tierIdx];

    for (let i = 0; i < entryCount; i++) {
      const idx = startOffset + i;
      const entryContext: TabularRow = { ...context };
      for (const f of tier.fields) {
        entryContext[f] = readFieldAt(record, f, idx);
      }

      if (isLeaf) {
        rows.push(entryContext);
      } else {
        const hingeArray = tier.hingeField ? record[tier.hingeField] : undefined;
        const childCount = Array.isArray(hingeArray) ? hingeArray[idx] ?? 0 : 0;
        walkArrayTier(tierIdx + 1, childCount, entryContext);
      }
    }

    offsets[tierIdx] += entryCount;
  }

  walkScalarTiers(0, {});
  return rows;
}

/**
 * Optional cheap dev-time guard: warns (does not throw) if a record's field
 * set diverges from the schema, or if a hinge tier's counts don't sum to
 * the length of the next tier's arrays. Safe to gate behind
 * `!environment.production`.
 */
export function warnIfSchemaViolated(record: SchemaRecord, schema: TierSchema): void {
  const { tiers } = schema;

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    for (const f of tier.fields) {
      if (!(f in record)) {
        console.warn(`[explodeRecordArray] Trade ${record.tradeId ?? '(unknown)'}: missing expected field "${f}" declared on tier "${tier.tierName}".`);
      }
    }

    if (tier.hingeField) {
      const hingeArray = record[tier.hingeField];
      const nextTier = tiers[i + 1];
      if (Array.isArray(hingeArray) && nextTier) {
        const expectedNextLength = hingeArray.reduce((sum: number, n: number) => sum + (n ?? 0), 0);
        const nextReferenceField = nextTier.fields.find((f) => Array.isArray(record[f]));
        if (nextReferenceField) {
          const actualNextLength = record[nextReferenceField].length;
          if (actualNextLength !== expectedNextLength) {
            console.warn(
              `[explodeRecordArray] Trade ${record.tradeId ?? '(unknown)'}: hinge "${tier.hingeField}" ` +
                `sums to ${expectedNextLength} but tier "${nextTier.tierName}" field "${nextReferenceField}" has length ${actualNextLength}.`
            );
          }
        }
      }
    }
  }
}

/**
 * Flattens an array of schema-conforming records (e.g. a full API response)
 * into one flat tabular row array.
 */
export function explodeRecordArray(
  records: SchemaRecord[],
  schema: TierSchema = TRADE_TIER_SCHEMA,
  { devCheck = true }: { devCheck?: boolean } = {}
): TabularRow[] {
  if (devCheck) {
    records.forEach((r) => warnIfSchemaViolated(r, schema));
  }
  return records.flatMap((r) => explodeRecord(r, schema));
}

/**
 * WIDE FLATTEN: unlike explodeRecord (1 record -> N rows), this flattens
 * 1 record -> 1 row, denormalizing every array-tier entry into its own
 * index-suffixed column instead of a new row.
 *
 * Suffix convention: a field's column name gets one numeric suffix per
 * array-tier ancestor (1-based, human-friendly), in outermost-to-innermost
 * order. E.g. with tiers [trade(scalar) -> leg(array) -> period(array)]:
 *   - leg-tier fields   => legs_1, legs_2, legDescriptions_1, ...
 *   - period-tier fields => periodNum_1_1, periodNum_1_2, ..., periodNum_2_1, ...
 *     (first index = leg position, second index = period position within that leg)
 *
 * CAVEAT: because different trades can have different leg/period counts,
 * wide-flattened rows across a batch will NOT share an identical key set
 * (trade1 might have keys up through `_3_40`, trade2 only through `_2_6`).
 * This is inherent to wide-flattening ragged data — a grid consuming this
 * output needs to compute the union of columns across ALL rows (unlike
 * explodeRecordArray, where the confirmed backend contract let us skip that).
 * Sparse cells should render blank, not be treated as a schema violation.
 */
export function flattenRecord(record: SchemaRecord, schema: TierSchema): TabularRow {
  const { tiers } = schema;
  const output: TabularRow = {};
  const offsets = new Array(tiers.length).fill(0);

  function walkScalarTiers(tierIdx: number): void {
    if (tierIdx >= tiers.length) return;
    const tier = tiers[tierIdx];
    if (tier.cardinality === 'scalar') {
      for (const f of tier.fields) output[f] = record[f] ?? null;
      walkScalarTiers(tierIdx + 1);
    } else {
      const referenceField = tier.fields.find((f) => Array.isArray(record[f]));
      const entryCount = referenceField ? record[referenceField].length : 0;
      walkArrayTier(tierIdx, entryCount, []);
    }
  }

  function walkArrayTier(tierIdx: number, entryCount: number, indices: number[]): void {
    const tier = tiers[tierIdx];
    const isLeaf = tierIdx === tiers.length - 1;
    const startOffset = offsets[tierIdx];

    for (let i = 0; i < entryCount; i++) {
      const idx = startOffset + i;
      const newIndices = [...indices, i + 1]; // 1-based suffixes

      for (const f of tier.fields) {
        const value = readFieldAt(record, f, idx);
        output[`${f}_${newIndices.join('_')}`] = value;
      }

      if (!isLeaf) {
        const hingeArray = tier.hingeField ? record[tier.hingeField] : undefined;
        const childCount = Array.isArray(hingeArray) ? hingeArray[idx] ?? 0 : 0;
        walkArrayTier(tierIdx + 1, childCount, newIndices);
      }
    }
    offsets[tierIdx] += entryCount;
  }

  walkScalarTiers(0);
  return output;
}

/** Wide-flattens an array of records: one output row per input trade (not per period). */
export function flattenRecordArray(
  records: SchemaRecord[],
  schema: TierSchema = TRADE_TIER_SCHEMA
): TabularRow[] {
  return records.map((r) => flattenRecord(r, schema));
}

/**
 * Computes the union of keys across a set of wide-flattened rows, in the
 * order first encountered. Needed before binding wide-flattened output to
 * a grid, since (unlike explodeRecordArray output) row key sets can legitimately
 * differ per trade.
 */
export function unionColumns(rows: TabularRow[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
}

/**
 * True if `field` is null/undefined for every trade in the batch — either
 * as a scalar (degenerate column, doesn't apply to that trade at all) or as
 * an array whose every element is null/undefined. Scans the RAW columnar
 * arrays directly (not exploded rows), so a value is inspected exactly
 * once regardless of how many output rows it would eventually contribute to.
 */
function isFullyNullAcrossRecords(records: SchemaRecord[], field: string): boolean {
  for (const record of records) {
    const value = record[field];
    if (Array.isArray(value)) {
      if (value.some((v) => v !== null && v !== undefined)) return false;
    } else if (value !== null && value !== undefined) {
      return false; // non-null scalar => field is genuinely used by this trade
    }
  }
  return true;
}

/**
 * Returns a pruned copy of the schema with fully-null fields removed from
 * each tier's `fields` list, based on scanning the WHOLE batch (never a
 * single trade in isolation — pruning per-trade would reintroduce the
 * "columns shift depending on trade order" bug that explodeRecordArray's
 * consistent-key-set guarantee exists to prevent).
 *
 * A tier's `hingeField` is never pruned, even if its values happen to all
 * be zero/null — it's structural (drives row counts for the next tier),
 * not a data column, so its "null-ness" isn't a usage signal.
 *
 * Run this once per fetched batch, BEFORE explodeRecordArray/flattenRecordArray
 * — pruning first means the flattener never allocates or writes the dropped
 * keys at all, rather than writing them and having a caller filter them out
 * afterward.
 */
export function pruneFullyNullFields(records: SchemaRecord[], schema: TierSchema): TierSchema {
  if (records.length === 0) return schema;

  return {
    tiers: schema.tiers.map((tier) => ({
      ...tier,
      fields: tier.fields.filter(
        (f) => f === tier.hingeField || !isFullyNullAcrossRecords(records, f)
      ),
    })),
  };
}
