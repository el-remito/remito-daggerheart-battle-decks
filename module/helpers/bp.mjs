/**
 * The Valiran Battle Points calculator.
 *
 * This is the single place in the module where a Battle Point number is produced. Everything
 * here is a pure function of its arguments plus the adversary type table; nothing touches the DOM
 * or mutates. That keeps it directly testable from the console via
 * game.modules.get(MODULE_ID).api.selfTest().
 *
 * The one indirect dependency is config/adversary-types.mjs, which resolves a type's cost from the
 * system and from this module's own override setting. It degrades to the system's built-in costs
 * when no settings are available, so this file still runs outside Foundry.
 *
 * Transcribed from "Daggerheart Valiran Combat Encounter Calculator.xlsx", sheet `Main_v2`.
 * Each function carries the originating cell so the rules can be traced back.
 *
 * An "entry" throughout this file is the module's encounter-line shape:
 *   { type: string, tier: number, quantity: number }
 * mirroring one row of Main_v2 columns B/D/C. Actor identity is irrelevant to the maths.
 */

import {
    MIN_TIER_DIFFERENCE,
    MAX_TIER_DIFFERENCE,
    DIFFICULTY,
    GROUP_POWER,
    COMPETENCE,
    ENVIRONMENT,
    EXTRA_DAMAGE_BP_PER_DIE,
    MANY_SOLOS_BP,
    TOUGHIE_TYPES,
    NO_TOUGHIES_BP
} from '../config/bp-tables.mjs';
import { effectiveTypes, rulesType } from '../config/adversary-types.mjs';

/**
 * Base BP cost of an adversary type, resolved rather than hardcoded.
 *
 * The system's ten built-in costs are identical to Reference!T7:U16, which is why the sheet and
 * the system agree on the sample encounter. A homebrew adversary type has no cost anywhere in the
 * system, so config/adversary-types.mjs supplies it from this module's own override setting.
 *
 * An unknown or still-unpriced type costs 0 here so the arithmetic stays total; the UI flags it
 * instead of pretending it is free. Use isPriced() when the distinction matters.
 *
 * @param {string} type Adversary type id, e.g. "bruiser".
 * @returns {number} Base cost in Battle Points, or 0 for an unknown or unpriced type.
 */
export function baseCost(type) {
    return effectiveTypes()[type]?.bpCost ?? 0;
}

/**
 * True when one BP buys a whole group of this type rather than a single creature.
 * Only `minion` carries this flag in the system, and it is why the sheet's row is labelled
 * "Minion (Group)" — its "# Amount" column counts groups, not individuals. A homebrew type can be
 * marked the same way from the Adversary BP Costs settings menu.
 *
 * @param {string} type Adversary type id.
 * @returns {boolean}
 */
export function isGrouped(type) {
    return effectiveTypes()[type]?.partyAmountPerBP === true;
}

/**
 * Reference!Q7:R13 — cost multiplier for fielding an adversary above or below the party's tier.
 * Exactly 2^difference, zeroed outside the table's [-3, 3] window (XLOOKUP default in Main_v2!F7).
 *
 * @param {number} difference adversaryTier - partyTier.
 * @returns {number}
 */
export function tierMultiplier(difference) {
    if (!Number.isFinite(difference)) return 0;
    if (difference < MIN_TIER_DIFFERENCE || difference > MAX_TIER_DIFFERENCE) return 0;
    return Math.pow(2, difference);
}

/**
 * Main_v2!E7 — the tier difference for one encounter line.
 * The sheet guards on both a positive amount and a real tier so that blank rows contribute 0
 * rather than being read as "tier 0", which would otherwise produce a huge negative difference.
 *
 * @param {object} entry     Encounter line, { tier, quantity }.
 * @param {number} partyTier Party tier, 1-4.
 * @returns {number}
 */
export function tierDifference(entry, partyTier) {
    const quantity = Number(entry?.quantity) || 0;
    const tier = Number(entry?.tier) || 0;
    if (quantity < 1 || tier < 1) return 0;
    return tier - partyTier;
}

/**
 * Main_v2!F7 — cost of a single unit of this line (one creature, or one group for minions).
 *
 * @param {object} entry     Encounter line, { type, tier, quantity }.
 * @param {number} partyTier Party tier, 1-4.
 * @returns {number}
 */
export function unitCost(entry, partyTier) {
    return baseCost(entry?.type) * tierMultiplier(tierDifference(entry, partyTier));
}

/**
 * Main_v2!G7 — total cost of an encounter line.
 *
 * @param {object} entry     Encounter line, { type, tier, quantity }.
 * @param {number} partyTier Party tier, 1-4.
 * @returns {number}
 */
export function lineCost(entry, partyTier) {
    return (Number(entry?.quantity) || 0) * unitCost(entry, partyTier);
}

/**
 * Main_v2!C19 — total spent on adversaries. The sheet stores this negated; we keep it positive
 * and subtract it in {@link computeBudget}, which reads more naturally in a UI.
 *
 * @param {object[]} entries Encounter lines.
 * @param {number}   partyTier Party tier, 1-4.
 * @returns {number}
 */
export function adversaryTotal(entries, partyTier) {
    return (entries ?? []).reduce((sum, entry) => sum + lineCost(entry, partyTier), 0);
}

/**
 * Sum the `quantity` of every line whose type is in `types`.
 * Main_v2!M9 and M10 both use SUMIF over the amount column, so a single line of two Solos
 * counts as two — not as one row.
 *
 * Matching is on the line's *rules* type, so a homebrew type declared "treated as a Solo" is
 * counted here exactly as a Solo would be. See rulesType() in config/adversary-types.mjs.
 *
 * @param {object[]} entries Encounter lines.
 * @param {string[]} types   Adversary type ids to include.
 * @returns {number}
 */
function countOfTypes(entries, types) {
    return (entries ?? [])
        .filter(entry => types.includes(rulesType(entry?.type)))
        .reduce((sum, entry) => sum + (Number(entry.quantity) || 0), 0);
}

/**
 * The two modifiers Main_v2 derives from the encounter's own composition rather than from a
 * GM choice. Returned individually as well as summed so the UI can show each row the way the
 * spreadsheet does, selection text included.
 *
 * @param {object[]} entries Encounter lines.
 * @returns {{manySolos: number, noToughies: number, soloCount: number, toughieCount: number,
 *           total: number}}
 */
export function derivedModifiers(entries) {
    const lines = entries ?? [];
    const soloCount = countOfTypes(lines, ['solo']);
    const toughieCount = countOfTypes(lines, TOUGHIE_TYPES);

    // Main_v2!M9 — IF(SUMIF(...,"Solo",...) >= 2, -2, 0)
    const manySolos = soloCount >= 2 ? MANY_SOLOS_BP : 0;

    // Main_v2!M10, sign-corrected: +1 only when the encounter fields no Bruiser, Horde, Leader or
    // Solo. See the NO_TOUGHIES_BP note in config/bp-tables.mjs for why the sheet's own formula is
    // not followed here.
    //
    // The empty-encounter guard matches the system's BPModifiers.noToughies, which also requires
    // `adversaries.length > 0`. Without it a blank encounter would score +1 for having no tough
    // adversaries, which reads as nonsense in the summary panel before anything is generated.
    const noToughies = lines.length > 0 && toughieCount === 0 ? NO_TOUGHIES_BP : 0;

    return { manySolos, noToughies, soloCount, toughieCount, total: manySolos + noToughies };
}

/**
 * The six modifiers the GM sets directly (four dropdowns, two numbers).
 *
 * @param {object} modifiers Builder modifier state; see defaultModifiers() in config/bp-tables.mjs.
 * @returns {{difficulty: number, extraDamage: number, groupPower: number, competence: number,
 *           environment: number, adHoc: number, total: number}}
 */
export function gmModifiers(modifiers = {}) {
    const difficulty = DIFFICULTY[modifiers.difficulty] ?? 0;
    const groupPower = GROUP_POWER[modifiers.groupPower] ?? 0;
    const competence = COMPETENCE[modifiers.competence] ?? 0;
    const environment = ENVIRONMENT[modifiers.environment] ?? 0;

    // Main_v2!M8 — L8 * (-2), where L8 is the number of d4 added to every adversary's damage.
    const extraDamage = (Number(modifiers.extraDamageDice) || 0) * EXTRA_DAMAGE_BP_PER_DIE;

    // Main_v2!M14 — free-form GM nudge, no lookup.
    const adHoc = Number(modifiers.adHoc) || 0;

    return {
        difficulty,
        extraDamage,
        groupPower,
        competence,
        environment,
        adHoc,
        total: difficulty + extraDamage + groupPower + competence + environment + adHoc
    };
}

/**
 * Main_v2!C18 — the starting budget. Identical to the system's
 * CONFIG.DH.ENCOUNTER.BaseBPPerEncounter, which is used in preference when available so the two
 * stay in step if the system ever revises the formula.
 *
 * @param {number} pcCount Number of player characters.
 * @returns {number}
 */
export function baseline(pcCount) {
    const count = Number(pcCount) || 0;
    const systemFormula = CONFIG.DH?.ENCOUNTER?.BaseBPPerEncounter;
    return typeof systemFormula === 'function' ? systemFormula(count) : 3 * count + 2;
}

/**
 * The starting budget, honouring a GM-assigned target if one is set.
 *
 * @param {number} pcCount    Number of player characters.
 * @param {number} [targetBP] Explicit budget. Ignored when null/undefined/non-finite; 0 is
 *                            respected, since "no budget at all" is a legitimate thing to ask for.
 * @returns {number}
 */
export function resolveBaseline(pcCount, targetBP) {
    const target = Number(targetBP);
    return Number.isFinite(target) && targetBP !== null && targetBP !== '' ? target : baseline(pcCount);
}

/**
 * The budget an encounter would start with if the GM named no target: the baseline plus every
 * modifier they have set.
 *
 * Shown as the Target BP field's placeholder, so "leave it blank" has a visible number attached
 * rather than making the GM work it out. The composition-driven modifiers are excluded on purpose
 * — they cannot be known before anything is drawn.
 *
 * @param {object} options
 * @param {number} options.pcCount     Number of player characters.
 * @param {object} [options.modifiers] Builder modifier state.
 * @returns {number}
 */
export function expectedBudget({ pcCount, modifiers = {} } = {}) {
    return baseline(pcCount) + gmModifiers(modifiers).total;
}

/**
 * The full Battle Points readout for an encounter — Main_v2!C18:C21.
 *
 * budgetLeft is `baseline - adversaries + modifiers`; the sheet reaches the same number by
 * summing a negated adversary total. Negative means over budget, which the sheet flags red and
 * the UI mirrors.
 *
 * @param {object}   options
 * @param {number}   options.partyTier Party tier, 1-4.
 * @param {number}   options.pcCount   Number of player characters.
 * @param {object[]} options.entries   Encounter lines.
 * @param {object}   options.modifiers Builder modifier state.
 * @param {number}   [options.targetBP] GM-assigned budget, used in place of the derived
 *                                      baseline. The brief allows the GM to name a target BP
 *                                      instead of taking `3 x PCs + 2`; modifiers still apply
 *                                      on top of it.
 * @returns {{baseline: number, adversaries: number, modifiers: number, budgetLeft: number,
 *           gm: object, derived: object}}
 */
export function computeBudget({ partyTier, pcCount, entries = [], modifiers = {}, targetBP } = {}) {
    const base = resolveBaseline(pcCount, targetBP);
    const adversaries = adversaryTotal(entries, partyTier);
    const gm = gmModifiers(modifiers);
    const derived = derivedModifiers(entries);
    const modifierTotal = gm.total + derived.total;

    return {
        baseline: base,
        adversaries,
        modifiers: modifierTotal,
        budgetLeft: base - adversaries + modifierTotal,
        gm,
        derived
    };
}

/**
 * What the encounter is allowed to spend given its current composition.
 *
 * The two derived modifiers depend on the roster, so the budget moves as adversaries are added:
 * the first Bruiser/Horde/Leader/Solo revokes the +1 no-toughies bonus, and a second Solo costs a
 * further -2. Both make the encounter more expensive than its face cost suggests. The generator
 * must therefore re-evaluate this after every candidate rather than computing a fixed budget up
 * front.
 *
 * @param {object}   options            Same shape as {@link computeBudget}.
 * @returns {number} Total BP available to spend on adversaries.
 */
export function spendable({ pcCount, entries = [], modifiers = {}, targetBP } = {}) {
    return (
        resolveBaseline(pcCount, targetBP) +
        gmModifiers(modifiers).total +
        derivedModifiers(entries).total
    );
}

/**
 * Reproduces the worked example in Main_v2 and asserts every intermediate value.
 *
 * Exposed on the module API so it can be run from the console after any change to the rules:
 *   game.modules.get('remito-daggerheart-battle-decks').api.selfTest()
 *
 * NOTE ON THE EXPECTED TOTALS. The spreadsheet prints Modifiers +3 and Budget Left 0 for this
 * encounter. This module expects +2 and -1, and the difference is entirely the corrected M10 sign
 * (see NO_TOUGHIES_BP in config/bp-tables.mjs): the sheet credits +1 for the Bruiser, whereas the
 * corrected rule credits nothing. Every other value below — the 8 / 2 / 0.5 unit costs, the
 * baseline and the adversary total — matches the sheet exactly, which is what this test is really
 * guarding.
 *
 * @returns {{passed: boolean, results: object[]}}
 */
export function selfTest() {
    const partyTier = 2;
    const pcCount = 3;

    // Main_v2 rows 7-9: Plenus, Parvus, Fanatic.
    const entries = [
        { type: 'bruiser', tier: 3, quantity: 1 },
        { type: 'standard', tier: 2, quantity: 2 },
        { type: 'support', tier: 1, quantity: 4 }
    ];

    // Main_v2 column L: Normal / +0d4 / High / Veterans / Unaligned / 0.
    const modifiers = {
        difficulty: 'normal',
        extraDamageDice: 0,
        groupPower: 'high',
        competence: 'veterans',
        environment: 'unaligned',
        adHoc: 0
    };

    const budget = computeBudget({ partyTier, pcCount, entries, modifiers });

    const results = [
        { label: 'unit cost Plenus (Bruiser T3)', expected: 8, actual: unitCost(entries[0], partyTier) },
        { label: 'unit cost Parvus (Standard T2)', expected: 2, actual: unitCost(entries[1], partyTier) },
        { label: 'unit cost Fanatic (Support T1)', expected: 0.5, actual: unitCost(entries[2], partyTier) },
        { label: 'line cost Plenus', expected: 8, actual: lineCost(entries[0], partyTier) },
        { label: 'line cost Parvus', expected: 4, actual: lineCost(entries[1], partyTier) },
        { label: 'line cost Fanatic', expected: 2, actual: lineCost(entries[2], partyTier) },
        { label: 'baseline (Main_v2!C18)', expected: 11, actual: budget.baseline },
        { label: 'adversaries (Main_v2!C19)', expected: 14, actual: budget.adversaries },
        { label: 'modifiers (sheet prints 3)', expected: 2, actual: budget.modifiers },
        { label: 'budget left (sheet prints 0)', expected: -1, actual: budget.budgetLeft },
        { label: 'toughie count', expected: 1, actual: budget.derived.toughieCount },
        { label: 'solo count', expected: 0, actual: budget.derived.soloCount },

        // The corrected M10, pinned in every direction so a future edit cannot quietly flip it.
        {
            label: 'no-toughies bonus: Bruiser present',
            expected: 0,
            actual: derivedModifiers(entries).noToughies
        },
        {
            label: 'no-toughies bonus: none present',
            expected: 1,
            actual: derivedModifiers([{ type: 'standard', tier: 2, quantity: 3 }]).noToughies
        },
        {
            label: 'no-toughies bonus: empty encounter',
            expected: 0,
            actual: derivedModifiers([]).noToughies
        },
        {
            label: 'toughies cost 1 BP more than not having them',
            expected: 1,
            actual:
                derivedModifiers([{ type: 'standard', tier: 2, quantity: 1 }]).total -
                derivedModifiers([{ type: 'bruiser', tier: 2, quantity: 1 }]).total
        },
        {
            label: 'two Solos charge a further 2 BP',
            expected: -2,
            actual: derivedModifiers([{ type: 'solo', tier: 2, quantity: 2 }]).manySolos
        }
    ].map(row => ({ ...row, ok: row.expected === row.actual }));

    const passed = results.every(row => row.ok);
    // eslint-disable-next-line no-console
    console[passed ? 'log' : 'error'](
        `Battle Decks | BP self-test ${passed ? 'passed' : 'FAILED'}`,
        results
    );
    return { passed, results };
}
