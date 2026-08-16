/**
 * The effective adversary type table — where a BP cost actually comes from.
 *
 * WHY THIS FILE EXISTS. The Daggerheart system lets a GM add custom adversary types through its
 * Homebrew setting, but the schema it stores them under is only { id, label, description }:
 *
 *   adversaryTypes: new fields.TypedObjectField(new fields.SchemaField({
 *       id: ..., label: ..., description: ...
 *   }))
 *
 * There is no bpCost field, so a custom type has no price anywhere in the system — the system's
 * own AdversaryBPPerEncounter falls back to `type.bpCost ?? 0`, silently costing it nothing. This
 * module therefore keeps its own cost table for types the system cannot price, editable from
 * Game Settings > Configure Settings > Adversary BP Costs.
 *
 * Resolution order for a type's cost, highest first:
 *   1. this module's override list (the TYPE_COSTS setting)
 *   2. the system's own `bpCost`, for the ten built-in types
 *   3. nothing — the type is "unpriced" and the UI says so rather than quietly charging 0
 *
 * ALIASES. A homebrew type can name one of the ten official types as its rules equivalent. The
 * alias becomes the type's `rulesType`, so a "Warbeast" treated as a Bruiser counts toward the
 * no-toughies modifier, and one treated as a Solo triggers the two-Solos charge — anything in the
 * rules that asks "is this a Bruiser?" gets the alias's answer.
 *
 * **An alias deliberately does NOT supply a cost.** Being treated as a Bruiser says how the type
 * behaves, not what it is worth; the GM prices every homebrew type themselves, and an aliased type
 * with no cost entered stays unpriced and is flagged as such. The one thing the alias does carry
 * across is `partyAmountPerBP`, because "one BP buys a whole group" is the substance of being a
 * Minion rather than a statement about price.
 *
 * IGNORING A TYPE. A type can be marked `ignored`, which takes it out of every draw pool without
 * removing anything from a deck. That is the difference between "I never want this rolled" and "I
 * do not own this" — an ignored adversary stays in its deck, keeps its cost, and is simply never
 * offered. It also stops counting as a problem: an ignored type that has no cost is not going to
 * corrupt a budget it can never appear in, so it is not reported as unpriced.
 *
 * Overrides are stored as an ARRAY of { id, bpCost, partyAmountPerBP, alias, ignored } rather than
 * a keyed object, because foundry.utils.mergeObject recurses into plain objects when a setting is
 * written but replaces arrays wholesale. An array is the only shape a key can actually be removed
 * from.
 */

import { MODULE_ID, SETTINGS } from './constants.mjs';

/**
 * The ten types the system ships with, used to tell core from homebrew.
 * @returns {object} Type id -> system type definition.
 */
export function coreTypes() {
    return CONFIG.DH?.ACTOR?.adversaryTypes ?? {};
}

/**
 * Every type the system knows about: its own ten plus anything the GM added via Homebrew.
 * @returns {object} Type id -> system type definition.
 */
export function systemTypes() {
    return CONFIG.DH?.ACTOR?.allAdversaryTypes?.() ?? {};
}

/**
 * This module's cost overrides, keyed by type id for lookup.
 *
 * Guarded because bp.mjs is deliberately runnable outside Foundry (see its self-test): with no
 * `game` in scope there are simply no overrides, and every built-in cost still resolves.
 *
 * @returns {object} Type id -> { bpCost?, partyAmountPerBP?, alias?, ignored? }.
 */
export function costOverrides() {
    let stored;
    try {
        stored = game.settings.get(MODULE_ID, SETTINGS.TYPE_COSTS);
    } catch {
        return {};
    }

    const overrides = {};
    for (const row of stored ?? []) {
        if (row?.id) overrides[row.id] = row;
    }
    return overrides;
}

/**
 * The merged table every other file should read instead of calling the system directly.
 *
 * Each entry carries the system's own fields plus ours:
 *   homebrew   - the GM added this type; the system has no cost for it
 *   priced     - a usable bpCost was resolved; an alias never provides one
 *   ignored    - never offered to the generator, though decks may still contain it
 *   overridden - this module's setting supplied the cost, the grouping flag, the alias or ignore
 *   alias      - the official type this homebrew type is treated as, or null
 *   rulesType  - alias ?? id; what the rules should match on
 *
 * @returns {object} Type id -> effective type definition.
 */
export function effectiveTypes() {
    const system = systemTypes();
    const core = coreTypes();
    const overrides = costOverrides();

    const merged = {};
    for (const [id, type] of Object.entries(system)) {
        const override = overrides[id];
        const homebrew = !(id in core);

        // Only a homebrew type may borrow an official type's identity, and only a real official
        // type may be borrowed — a stale alias left over from a deleted type resolves to nothing.
        const alias =
            homebrew && typeof override?.alias === 'string' && core[override.alias]
                ? override.alias
                : null;
        const aliased = alias ? core[alias] : null;

        // The alias is not consulted here on purpose — see the note at the top of the file. A
        // homebrew type is worth whatever the GM says it is worth, and nothing until they say.
        const cost = Number.isFinite(override?.bpCost)
            ? override.bpCost
            : Number.isFinite(type.bpCost)
              ? type.bpCost
              : undefined;

        const grouped =
            typeof override?.partyAmountPerBP === 'boolean'
                ? override.partyAmountPerBP
                : aliased
                  ? aliased.partyAmountPerBP === true
                  : type.partyAmountPerBP === true;

        merged[id] = {
            ...type,
            id: type.id ?? id,
            bpCost: cost,
            partyAmountPerBP: grouped,
            homebrew,
            alias,
            rulesType: alias ?? id,
            priced: Number.isFinite(cost),
            // Never inherited from an alias: whether a type is worth rolling is the GM's call
            // about their own table, not something "behaves like a Bruiser" has an opinion on.
            ignored: override?.ignored === true,
            overridden: Boolean(override)
        };
    }
    return merged;
}

/**
 * The type id the rules should match on: a homebrew type's alias where one is set, otherwise the
 * type itself. This is what makes "treated as a Bruiser" actually behave like a Bruiser in
 * bp.derivedModifiers().
 *
 * Falls back to the id it was given, so an entry whose type no longer exists still compares
 * sanely instead of collapsing to undefined.
 *
 * @param {string} type Adversary type id.
 * @returns {string}
 */
export function rulesType(type) {
    return effectiveTypes()[type]?.rulesType ?? type;
}

/**
 * Does this type have a cost the module can actually charge?
 *
 * A cost of 0 counts as priced — "free" is a legitimate thing for a GM to configure, and is
 * treated differently from "nobody ever said".
 *
 * @param {string} type Adversary type id.
 * @returns {boolean}
 */
export function isPriced(type) {
    return effectiveTypes()[type]?.priced === true;
}

/**
 * Has this type been switched off for encounter generation?
 *
 * Ignoring is a draw-pool filter, nothing more. An ignored adversary can still sit in a deck, still
 * costs whatever it costs, and an encounter that already contains one keeps it — it is simply never
 * picked again.
 *
 * @param {string} type Adversary type id.
 * @returns {boolean}
 */
export function isIgnored(type) {
    return effectiveTypes()[type]?.ignored === true;
}

/**
 * Localized label for a type, falling back to the raw id for a type that no longer exists
 * (a homebrew type the GM deleted while it was still sitting in a deck).
 *
 * @param {string} type Adversary type id.
 * @returns {string}
 */
export function typeLabel(type) {
    const label = effectiveTypes()[type]?.label;
    return label ? game.i18n.localize(label) : type;
}

/**
 * Every type that still has no cost AND can still turn up in an encounter.
 *
 * An ignored type is left out: it will never be drawn, so its missing cost cannot corrupt a budget
 * and nagging about it would only train the GM to ignore the warning.
 *
 * @returns {Array<{id: string, label: string}>}
 */
export function unpricedTypes() {
    return Object.values(effectiveTypes())
        .filter(type => !type.priced && !type.ignored)
        .map(type => ({ id: type.id, label: typeLabel(type.id) }));
}
