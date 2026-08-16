/**
 * Encounter generation — drawing, stacking, re-rolling and putting back.
 *
 * A generated encounter is a list of "cards". A card is one row of Main_v2 plus enough display
 * data to render it:
 *
 *   {
 *     key: string,        // stable id: the actor UUID, or "role:<type>" in deckless mode
 *     uuid: string|null,  // null for a deckless role card, which has no actor behind it
 *     name: string,
 *     img: string|null,
 *     type: string,       // adversary type id, e.g. "bruiser"
 *     tier: number,
 *     quantity: number    // creatures; for minions this counts GROUPS, not individuals
 *   }
 *
 * Cards are also valid `entries` for module/helpers/bp.mjs, which only reads type/tier/quantity.
 *
 * FROZEN CARDS
 *
 * `state.lockedCards` holds the keys the GM has frozen. A frozen card is immutable in the strongest
 * sense the word allows here: it is not redrawn, not trimmed, not re-rolled, and — the part that is
 * easy to miss — never *drawn into*. That last rule is why every draw path filters the pool by key
 * rather than only leaving the card list alone: without it, a fresh Generate could roll the same
 * adversary again, `stack` would find the frozen card and increment it, and a card the GM froze at
 * x2 would quietly become x3.
 *
 * Frozen cards are carried into a new generation and their cost is counted against the budget, so
 * the draw fills what is left around them rather than spending the budget twice.
 */

import { GENERATION_MODE, MAX_DRAW_ITERATIONS, NS } from '../config/constants.mjs';
import { effectiveTypes, typeLabel, isPriced, isIgnored } from '../config/adversary-types.mjs';
import { resolvePool } from '../data/decks.mjs';
import { computeBudget, spendable, adversaryTotal, unitCost, isGrouped } from './bp.mjs';

/**
 * Deckless pool: the adversary *categories* themselves, per the brief's "Deckless" rule.
 *
 * Every role is offered at the party's own tier so the tier multiplier is 1 and each category
 * costs exactly its base BP — the abstract shape of an encounter, with no actors attached.
 *
 * @param {number} partyTier Party tier, 1-4.
 * @returns {object[]} Pool entries.
 */
export function rolePool(partyTier) {
    return Object.values(effectiveTypes())
        .filter(type => !type.ignored)
        .map(type => ({
            key: `role:${type.id}`,
            uuid: null,
            name: typeLabel(type.id),
            img: null,
            type: type.id,
            tier: partyTier
        }));
}

/**
 * Resolve the draw pool for a generation run.
 * Selecting no decks is not an error — it is the deckless mode.
 *
 * Ignored types are dropped here, which is the one place worth doing it: every draw path — a fresh
 * generate, Draw Another, and a single-card re-roll — comes through this function, so a type the GM
 * has switched off cannot re-enter an encounter by any route. Cards already on the table are left
 * alone; ignoring a type is not a retroactive edit of an encounter the GM has already accepted.
 *
 * @param {object} state Encounter state.
 * @returns {Promise<object[]>} Pool entries.
 */
export async function buildPool(state) {
    if (!state.deckIds?.length) return rolePool(state.partyTier);
    const pool = await resolvePool(state.deckIds);
    return pool.filter(entry => !isIgnored(entry.type)).map(entry => ({ ...entry, key: entry.uuid }));
}

/**
 * The keys the GM has frozen, as a Set for the filtering every draw path does.
 *
 * @param {object} state Encounter state.
 * @returns {Set<string>}
 */
function lockedKeys(state) {
    return new Set(state.lockedCards ?? []);
}

/**
 * The frozen cards themselves, copied so a caller can build a new list on top of them.
 *
 * @param {object} state Encounter state.
 * @returns {object[]}
 */
function frozenCards(state) {
    const locked = lockedKeys(state);
    return (state.cards ?? []).filter(card => locked.has(card.key)).map(card => ({ ...card }));
}

/**
 * Add one unit of a pool entry to the card list, stacking onto an existing card when the same
 * adversary comes up again. Mirrors Main_v2's "# Amount" column and the system's own
 * AdversaryBPPerEncounter, which groups identical adversaries before costing them.
 *
 * @param {object[]} cards Card list, mutated in place.
 * @param {object}   entry Pool entry.
 */
function stack(cards, entry) {
    const existing = cards.find(card => card.key === entry.key);
    if (existing) existing.quantity += 1;
    else cards.push({ ...entry, quantity: 1 });
}

/**
 * Would the encounter still be within budget with one more of `entry` in it?
 *
 * Re-evaluates the whole budget rather than comparing against a cached remainder, because the two
 * derived modifiers move with the composition: the first Bruiser/Horde/Leader/Solo revokes the +1
 * no-toughies bonus, and a second Solo charges a further -2. Both mean a candidate can cost more
 * than its own price tag. See the note in bp.mjs on {@link spendable}.
 *
 * @param {object[]} cards Current cards.
 * @param {object}   entry Candidate pool entry.
 * @param {object}   state Encounter state.
 * @returns {boolean}
 */
function affords(cards, entry, state) {
    const candidate = cards.map(card => ({ ...card }));
    stack(candidate, entry);
    return adversaryTotal(candidate, state.partyTier) <= spendable({ ...state, entries: candidate });
}

/**
 * Pick one entry at random, biased toward expensive adversaries and away from ones already drawn.
 *
 * A flat random pick tends to produce a wall of cheap Supports, because cheap entries stay
 * affordable for far longer. Weighting by unit cost front-loads the big threats; dividing by the
 * number already taken keeps a single adversary from filling the whole roster without ever
 * forbidding a repeat.
 *
 * @param {object[]} entries Affordable pool entries.
 * @param {object[]} cards   Current cards, for the repeat penalty.
 * @param {object}   state   Encounter state.
 * @returns {object} The chosen entry.
 */
function weightedPick(entries, cards, state) {
    const weights = entries.map(entry => {
        const taken = cards.find(card => card.key === entry.key)?.quantity ?? 0;
        // Floor the cost so a 0.5 BP Support still has a real chance of being picked.
        return Math.max(unitCost(entry, state.partyTier), 0.25) / (1 + taken);
    });

    const total = weights.reduce((sum, weight) => sum + weight, 0);
    if (total <= 0) return entries[Math.floor(Math.random() * entries.length)];

    let roll = Math.random() * total;
    for (let i = 0; i < entries.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return entries[i];
    }
    return entries[entries.length - 1];
}

/**
 * "Fill BP budget" mode — keep drawing while anything in the pool still fits.
 *
 * Starts from the frozen cards rather than from nothing, which is all it takes to make the budget
 * account for them: `affords` costs the whole prospective roster every time, so a frozen Bruiser
 * eats its 4 BP out of the budget before the first card is drawn, and its type feeds the two
 * composition-driven modifiers exactly as a drawn one would.
 *
 * @param {object[]} pool  Pool entries, frozen keys already removed.
 * @param {object}   state Encounter state.
 * @param {object[]} kept  Frozen cards to build on top of.
 * @returns {object[]} Cards.
 */
function fillBudget(pool, state, kept = []) {
    // A zero-cost entry can never use up any budget, so it would stay "affordable" until the
    // iteration cap and bury the roster under 200 copies of itself. That is exactly what an
    // unpriced homebrew type looks like, which is why budget mode leaves those out entirely —
    // generate() has already warned the GM that they need a cost.
    const costed = pool.filter(entry => unitCost(entry, state.partyTier) > 0);
    if (!costed.length) {
        ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.nothingPriced`));
        // The frozen cards are still the GM's encounter; an empty pool is no reason to drop them.
        return kept;
    }

    const cards = [...kept];
    for (let i = 0; i < MAX_DRAW_ITERATIONS; i++) {
        const affordable = costed.filter(entry => affords(cards, entry, state));
        if (!affordable.length) break;
        stack(cards, weightedPick(affordable, cards, state));
    }
    return cards;
}

/**
 * "Free draw" mode — take a fixed number of adversaries and report the damage afterwards.
 *
 * Deliberately unweighted and unbudgeted: this is the GM asking "give me four of these", and the
 * resulting Budget Left is allowed to go negative (the UI shows it in red, as the sheet does).
 *
 * Draw is a roster size, not a number of new faces, so frozen cards count toward it — the same
 * reading as budget mode, where the frozen cards spend from the same budget rather than being
 * granted one of their own. "Draw 4" with two frozen adversaries on the table draws two more.
 *
 * @param {object[]} pool  Pool entries, frozen keys already removed.
 * @param {object}   state Encounter state.
 * @param {object[]} kept  Frozen cards to build on top of.
 * @returns {object[]} Cards.
 */
function drawFree(pool, state, kept = []) {
    const cards = [...kept];
    const held = kept.reduce((sum, card) => sum + card.quantity, 0);
    const count = Math.max(0, Math.min(Number(state.drawCount) || 0, MAX_DRAW_ITERATIONS) - held);
    for (let i = 0; i < count; i++) {
        stack(cards, pool[Math.floor(Math.random() * pool.length)]);
    }
    return cards;
}

/**
 * Warn once per run about adversaries whose type has no BP cost.
 *
 * Silence here would be the worst outcome: an unpriced type costs 0, so the encounter would look
 * comfortably within budget while being nothing of the sort. The message names the types and
 * points at the settings menu that fixes them.
 *
 * @param {object[]} pool Pool entries.
 */
function warnUnpriced(pool) {
    const unpriced = [...new Set(pool.filter(entry => !isPriced(entry.type)).map(entry => entry.type))];
    if (!unpriced.length) return;

    ui.notifications?.warn(
        game.i18n.format(`${NS}.Notification.unpricedTypes`, {
            types: unpriced.map(type => typeLabel(type)).join(', ')
        })
    );
}

/**
 * Generate a fresh encounter from the current builder state.
 *
 * @param {object} state Encounter state.
 * @returns {Promise<object[]>} Cards. Empty when the selected decks hold no usable adversaries.
 */
export async function generate(state) {
    const pool = await buildPool(state);
    const kept = frozenCards(state);
    if (!pool.length) {
        ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.emptyPool`));
        return kept;
    }

    warnUnpriced(pool);

    // Frozen adversaries leave the pool: they are already on the table and must not be drawn a
    // second time, because a second draw would stack onto them and increase a count the GM froze.
    const locked = lockedKeys(state);
    const drawable = pool.filter(entry => !locked.has(entry.key));
    if (!drawable.length) {
        ui.notifications?.info(game.i18n.localize(`${NS}.Notification.allFrozen`));
        return kept;
    }

    return state.mode === GENERATION_MODE.FREE
        ? drawFree(drawable, state, kept)
        : fillBudget(drawable, state, kept);
}

/**
 * Draw one more adversary onto the encounter already on the table.
 *
 * The counterpart to Generate: Generate replaces the roster with a fresh draw, this adds a single
 * adversary and leaves everything else — including quantities the GM has already trimmed by hand —
 * exactly as it stands.
 *
 * Unweighted and unbudgeted in *both* modes. It is offered in budget mode too (v1.2.0), and it
 * deliberately does not start respecting the budget there: one button doing two different things
 * depending on a dropdown three fields away is worse than one button that always means "give me one
 * more". Overshooting turns Budget Left red, which is the whole point of showing that number.
 *
 * @param {object} state Encounter state (cards included).
 * @returns {Promise<object[]|null>} New card list, or null when there was nothing to draw.
 */
export async function drawOne(state) {
    const pool = await buildPool(state);
    if (!pool.length) {
        ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.emptyPool`));
        return null;
    }

    warnUnpriced(pool);

    // Same rule as Generate: drawing a frozen adversary again would stack onto its card.
    const locked = lockedKeys(state);
    const drawable = pool.filter(entry => !locked.has(entry.key));
    if (!drawable.length) {
        ui.notifications?.info(game.i18n.localize(`${NS}.Notification.allFrozen`));
        return null;
    }

    const cards = (state.cards ?? []).map(card => ({ ...card }));
    stack(cards, drawable[Math.floor(Math.random() * drawable.length)]);
    return cards;
}

/**
 * Re-roll one unit of a card, keeping the encounter's shape intact.
 *
 * Swaps in a different adversary of the *same* type wherever possible, so the BP cost is
 * unchanged unless the replacement sits at a different tier. If the pool holds no other adversary
 * of that type, falls back to any replacement that keeps the encounter within budget.
 *
 * ONE UNIT, not the whole stack (changed in v1.2.0). A x2 Bandits card re-rolled once leaves one
 * Bandit on the table and turns the other into something else, mirroring "Put one back" next to it.
 * Re-rolling the pair wholesale made a stacked card impossible to nudge: the only way to change
 * half of it was to put one back and hope the next draw refilled the slot.
 *
 * @param {object} state Encounter state (cards included).
 * @param {string} key   Card key to draw one unit away from.
 * @returns {Promise<object[]|null>} New card list, or null if no replacement was possible.
 */
export async function rerollCard(state, key) {
    const pool = await buildPool(state);
    const current = state.cards.find(card => card.key === key);
    if (!current) return null;

    const others = state.cards.filter(card => card.key !== key);
    const taken = new Set(state.cards.map(card => card.key));
    const currentTotal = adversaryTotal(state.cards, state.partyTier);

    /**
     * The card list that would result from moving one unit of this slot onto `entry`.
     *
     * The remainder of the stack keeps its position, and the replacement is spliced in directly
     * after it rather than appended, so a re-roll does not rearrange the grid under the pointer.
     */
    const replace = entry => {
        const next = [];
        for (const card of state.cards) {
            if (card.key !== key) {
                next.push({ ...card });
                continue;
            }
            if (card.quantity > 1) next.push({ ...card, quantity: card.quantity - 1 });
            next.push({ ...entry, quantity: 1 });
        }
        // The replacement may collide with a card already on the table; merge rather than duplicate.
        return next.reduce((acc, card) => {
            const existing = acc.find(other => other.key === card.key);
            if (existing) existing.quantity += card.quantity;
            else acc.push({ ...card });
            return acc;
        }, []);
    };

    /**
     * A re-roll may never make the encounter worse than it already is.
     *
     * Accept a replacement if the result is within budget, or if it costs no more than the
     * encounter already does. The second clause is what keeps re-roll usable in free-draw mode,
     * where the roster is deliberately over budget.
     */
    const acceptable = entry => {
        const next = replace(entry);
        const total = adversaryTotal(next, state.partyTier);
        return total <= spendable({ ...state, entries: next }) || total <= currentTotal;
    };

    // Frozen cards are excluded as replacements for the usual reason: merging into one would
    // increase a count the GM froze.
    const locked = lockedKeys(state);
    const candidates = pool.filter(
        entry => entry.key !== key && !locked.has(entry.key) && acceptable(entry)
    );

    // Prefer another adversary of the same role, so the encounter keeps its shape.
    const sameType = candidates.filter(entry => entry.type === current.type);
    if (sameType.length) {
        // Prefer a genuinely new face over one already in the encounter.
        const fresh = sameType.filter(entry => !taken.has(entry.key));
        const choices = fresh.length ? fresh : sameType;
        return replace(choices[Math.floor(Math.random() * choices.length)]);
    }

    if (!candidates.length) {
        ui.notifications?.info(game.i18n.localize(`${NS}.Notification.noReroll`));
        return null;
    }
    return replace(weightedPick(candidates, others, state));
}

/**
 * Put one unit of a card back into the deck.
 *
 * Removes a single creature (or, for minions, a single group) so a stacked card can be trimmed
 * rather than only cleared; the card disappears once its last unit is returned.
 *
 * @param {object[]} cards Current cards.
 * @param {string}   key   Card key.
 * @returns {object[]} New card list.
 */
export function putBack(cards, key) {
    return cards
        .map(card => (card.key === key ? { ...card, quantity: card.quantity - 1 } : card))
        .filter(card => card.quantity > 0);
}

/**
 * Decorate cards with the values the template needs but should not compute itself.
 *
 * `displayCount` is what the GM actually sees on the badge: for a grouped type (minions) one
 * unit of BP buys a whole group of party-size creatures, so the badge shows the head count while
 * the cost still reflects the number of groups.
 *
 * @param {object[]} cards   Cards.
 * @param {object}   state   Encounter state.
 * @returns {object[]} Cards with cost/display fields added.
 */
export function decorateCards(cards, state) {
    const locked = lockedKeys(state);
    return (cards ?? []).map(card => {
        const grouped = isGrouped(card.type);
        const displayCount = grouped ? card.quantity * state.pcCount : card.quantity;
        return {
            ...card,
            grouped,
            displayCount,
            // Drives the ribbon and disables this card's own re-roll and put-back buttons.
            locked: locked.has(card.key),
            // Flags a type with no configured cost, which is charging 0 and should not be trusted.
            unpriced: !isPriced(card.type),
            typeLabel: typeLabel(card.type),
            unitCost: unitCost(card, state.partyTier),
            lineCost: unitCost(card, state.partyTier) * card.quantity
        };
    });
}

/**
 * Full BP readout for the current encounter, for the summary panel.
 *
 * @param {object} state Encounter state.
 * @returns {object} See computeBudget().
 */
export function budgetFor(state) {
    return computeBudget({ ...state, entries: state.cards ?? [] });
}
