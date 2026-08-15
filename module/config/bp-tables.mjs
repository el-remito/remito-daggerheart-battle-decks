/**
 * The Valiran Battle Points lookup tables.
 *
 * Every value here is transcribed from "Daggerheart Valiran Combat Encounter Calculator.xlsx",
 * hidden sheet `Reference`, which is the source of truth for this module. Cell references are
 * given so any future rules change can be traced back to the spreadsheet.
 *
 * Sign convention throughout: a modifier ADDS to the Battle Point budget. A negative value
 * therefore makes the encounter *cost* more, and a positive value gives the GM more to spend.
 */

/** Reference!B7:C11 — "Encounter Length / Difficulty". */
export const DIFFICULTY = {
    muchEasier: -2,
    easier: -1,
    normal: 0,
    harder: 1,
    muchHarder: 2
};

/** Reference!E7:F9 — "Group Power Level". */
export const GROUP_POWER = {
    low: -1,
    normal: 0,
    high: 1
};

/** Reference!H7:I9 — "Player Competence & Tactics". */
export const COMPETENCE = {
    beginner: -1,
    experienced: 0,
    veterans: 1
};

/** Reference!K7:L9 — "Envinroment Conditions" (sic, spelling preserved from the sheet). */
export const ENVIRONMENT = {
    alliedToPc: 1,
    unaligned: 0,
    againstPc: -1
};

/**
 * Reference!Q7:R13 — "Tier Difference" multiplier applied to an adversary's base cost.
 *
 * The table is exactly 2^d over d in [-3, 3]. XLOOKUP in Main_v2!F7 passes a default of 0,
 * so a difference outside that window zeroes the cost rather than extrapolating. Party and
 * adversary tiers are both constrained to 1-4, so |d| can never exceed 3 in practice; the
 * bound is enforced anyway to keep the function total.
 */
export const MIN_TIER_DIFFERENCE = -3;
export const MAX_TIER_DIFFERENCE = 3;

/** Main_v2!L8 data validation — the +Xd4 damage modifier accepts 0 through 6. */
export const MAX_EXTRA_DAMAGE_DICE = 6;

/** BP granted (negative: charged) per d4 of bonus damage added to every adversary. Main_v2!M8. */
export const EXTRA_DAMAGE_BP_PER_DIE = -2;

/** BP charged when the encounter fields two or more Solo adversaries. Main_v2!M9. */
export const MANY_SOLOS_BP = -2;

/** Adversary types that count as "toughies". Main_v2!M10. */
export const TOUGHIE_TYPES = ['bruiser', 'horde', 'leader', 'solo'];

/**
 * BP granted when the encounter fields NO Bruiser, Horde, Leader or Solo. Main_v2!M10.
 *
 * CORRECTION TO THE SOURCE SHEET — the one place this module knowingly departs from Main_v2.
 *
 * Main_v2!M10 reads `IF(<toughie count> = 0, 0, 1)`, granting +1 when a toughie IS present.
 * Because modifiers add to the budget (Budget Left = Baseline - Adversaries + Modifiers), that
 * hands the GM a 1 BP *discount* for fielding a big monster. It is also inconsistent with the two
 * rows beside it, where making adversaries stronger costs budget: +Xd4 damage is -2 per die and
 * 2+ Solos is -2.
 *
 * The hidden v1 sheet had it the other way round (`IF(SUM(...)=0, 1, 0)`), as do the Daggerheart
 * SRD and the system's own CONFIG.DH.ENCOUNTER.BPModifiers[1].noToughies. The v2 rewrite flipped
 * the condition while keeping the sign. Confirmed with the author 2026-08-16: a toughie-free
 * fight is the easier one and earns +1 BP; a fight with toughies earns nothing.
 */
export const NO_TOUGHIES_BP = 1;

/** Main_v2!C2 / C3 data validation ranges. */
export const TIER_RANGE = { min: 1, max: 4 };
export const PARTY_SIZE_RANGE = { min: 1, max: 8 };

/**
 * What a brand-new encounter starts with, matching Main_v2's own sample (Tier 2, 3 PCs).
 *
 * These are first-run defaults only. The Battle Encounters window is the single source of truth
 * for party tier and size — there is no setting for either — and whatever the GM last typed is
 * remembered in the `encounter` world setting, so these two values are seen once and then never
 * again.
 */
export const PARTY_DEFAULTS = { partyTier: 2, pcCount: 3 };

/**
 * The four GM-chosen dropdown modifiers, in the order Main_v2 lists them down column J.
 * Rendered generically by the builder template so adding a row here is enough to surface it.
 */
export const SELECT_MODIFIERS = [
    { key: 'difficulty', table: DIFFICULTY, default: 'normal' },
    { key: 'groupPower', table: GROUP_POWER, default: 'normal' },
    { key: 'competence', table: COMPETENCE, default: 'experienced' },
    { key: 'environment', table: ENVIRONMENT, default: 'unaligned' }
];

/**
 * The builder's starting modifier state — the sheet's own defaults.
 * Derived from SELECT_MODIFIERS so the defaults cannot drift away from the dropdowns.
 */
export function defaultModifiers() {
    const modifiers = { extraDamageDice: 0, adHoc: 0 };
    for (const row of SELECT_MODIFIERS) modifiers[row.key] = row.default;
    return modifiers;
}
