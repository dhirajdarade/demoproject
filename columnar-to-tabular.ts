/**
 * Generic, schema-driven flattener for ragged nested Structure-of-Arrays
 * (SoA) records — e.g. trade -> leg -> period — into a flat tabular row
 * array suitable for mat-table / ag-grid / any Angular data-source binding.
 *
 * Instead of hardcoding field names, the shape of the record is described
 * by a TierSchema. Each tier is one "grain" (header grain, leg grain, leaf
 * grain, ...). explodeTrades() walks the schema generically, so adding a
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
        console.warn(`[explodeTrades] Trade ${record.tradeId ?? '(unknown)'}: missing expected field "${f}" declared on tier "${tier.tierName}".`);
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
              `[explodeTrades] Trade ${record.tradeId ?? '(unknown)'}: hinge "${tier.hingeField}" ` +
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
export function explodeTrades(
  records: SchemaRecord[],
  schema: TierSchema = TRADE_TIER_SCHEMA,
  { devCheck = true }: { devCheck?: boolean } = {}
): TabularRow[] {
  if (devCheck) {
    records.forEach((r) => warnIfSchemaViolated(r, schema));
  }
  return records.flatMap((r) => explodeRecord(r, schema));
}
