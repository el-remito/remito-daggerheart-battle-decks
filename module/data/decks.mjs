/**
 * Deck persistence — the sole read/write path for the deck catalogue.
 *
 * UI code must never call game.settings for decks directly; route everything through here so
 * validation, GM gating and cache invalidation happen in exactly one place. (Same discipline as
 * remito-reputation-tracker's data-manager.js.)
 *
 * Stored shape, in the `decks` world setting:
 *   [{ id: string, name: string, uuids: string[] }]
 *
 * Only UUIDs are stored, never copies of the actor. A deck can therefore mix world actors and
 * compendium adversaries, and edits to an adversary are picked up automatically.
 */

import { MODULE_ID, SETTINGS, ADVERSARY_TYPE, NS } from '../config/constants.mjs';

/**
 * Resolved-actor cache, keyed by UUID. Hydrating a deck hits fromUuid once per adversary and the
 * builder re-reads the pool on every render and every re-roll, so without this a large deck would
 * re-fetch compendium documents dozens of times per generation.
 * @type {Map<string, object|null>}
 */
const resolvedCache = new Map();

/** Drop the hydration cache. Called whenever a deck changes or an actor is updated/deleted. */
export function invalidateCache() {
    resolvedCache.clear();
}

/** @returns {object[]} All decks. Always a fresh copy — callers may mutate it freely. */
export function getDecks() {
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.DECKS) ?? []);
}

/**
 * @param {string} id Deck id.
 * @returns {object|undefined} The deck, or undefined if it no longer exists.
 */
export function getDeck(id) {
    return getDecks().find(deck => deck.id === id);
}

/**
 * Guard every mutation. Non-GMs get a warning rather than an exception, because these paths are
 * reachable from UI that a stray permission change could expose.
 * @returns {boolean} True when the caller may write.
 */
function assertGM() {
    if (game.user.isGM) return true;
    ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.gmOnly`));
    return false;
}

/**
 * Persist the catalogue and refresh any open module window.
 * @param {object[]} decks Full replacement catalogue.
 */
async function save(decks) {
    await game.settings.set(MODULE_ID, SETTINGS.DECKS, decks);
    invalidateCache();
}

/**
 * @param {string} [name] Deck name; falls back to a localized default.
 * @returns {Promise<object|null>} The created deck.
 */
export async function createDeck(name) {
    if (!assertGM()) return null;
    const decks = getDecks();
    const deck = {
        id: foundry.utils.randomID(),
        name: name?.trim() || game.i18n.localize(`${NS}.Deck.newDeckName`),
        uuids: []
    };
    decks.push(deck);
    await save(decks);
    return deck;
}

/**
 * @param {string} id   Deck id.
 * @param {string} name New name; blank names are ignored.
 */
export async function renameDeck(id, name) {
    if (!assertGM()) return;
    const trimmed = name?.trim();
    if (!trimmed) return;
    const decks = getDecks();
    const deck = decks.find(entry => entry.id === id);
    if (!deck) return;
    deck.name = trimmed;
    await save(decks);
}

/** @param {string} id Deck id. */
export async function deleteDeck(id) {
    if (!assertGM()) return;
    await save(getDecks().filter(deck => deck.id !== id));
}

/**
 * Add an adversary to a deck.
 *
 * Rejects anything that is not an `adversary` actor, and refuses duplicates within the same deck
 * (the brief's "no UUID duplicates" rule). The same adversary may appear in several decks.
 *
 * @param {string} deckId Deck id.
 * @param {string} uuid   Actor UUID, world or compendium.
 * @returns {Promise<boolean>} True when the deck changed.
 */
export async function addToDeck(deckId, uuid) {
    if (!assertGM()) return false;

    const decks = getDecks();
    const deck = decks.find(entry => entry.id === deckId);
    if (!deck) return false;

    if (deck.uuids.includes(uuid)) {
        ui.notifications?.info(game.i18n.localize(`${NS}.Notification.duplicate`));
        return false;
    }

    const actor = await fromUuid(uuid).catch(() => null);
    if (!actor) {
        ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.unresolved`));
        return false;
    }
    if (actor.type !== ADVERSARY_TYPE) {
        ui.notifications?.warn(
            game.i18n.format(`${NS}.Notification.notAnAdversary`, { name: actor.name })
        );
        return false;
    }

    deck.uuids.push(uuid);
    await save(decks);
    return true;
}

/**
 * @param {string} deckId Deck id.
 * @param {string} uuid   Actor UUID to drop.
 */
export async function removeFromDeck(deckId, uuid) {
    if (!assertGM()) return;
    const decks = getDecks();
    const deck = decks.find(entry => entry.id === deckId);
    if (!deck) return;
    deck.uuids = deck.uuids.filter(entry => entry !== uuid);
    await save(decks);
}

/**
 * Hydrate one UUID into the flat shape the rest of the module works with.
 *
 * Returns null for a UUID that no longer resolves (actor deleted, compendium disabled) so callers
 * can filter it out; the stale UUID is left in the deck rather than silently pruned, so that
 * re-enabling a compendium restores the deck intact.
 *
 * @param {string} uuid Actor UUID.
 * @returns {Promise<object|null>} { uuid, name, img, type, tier } or null.
 */
export async function resolveAdversary(uuid) {
    if (resolvedCache.has(uuid)) return resolvedCache.get(uuid);

    const actor = await fromUuid(uuid).catch(() => null);
    const entry =
        actor && actor.type === ADVERSARY_TYPE
            ? {
                  uuid,
                  name: actor.name,
                  img: actor.img,
                  type: actor.system?.type ?? 'standard',
                  tier: Number(actor.system?.tier) || 1
              }
            : null;

    resolvedCache.set(uuid, entry);
    return entry;
}

/**
 * @param {string} id Deck id.
 * @returns {Promise<object[]>} Hydrated adversaries, unresolvable UUIDs omitted.
 */
export async function resolveDeck(id) {
    const deck = getDeck(id);
    if (!deck) return [];
    const resolved = await Promise.all(deck.uuids.map(resolveAdversary));
    return resolved.filter(entry => entry !== null);
}

/**
 * Build the draw pool for a generation run: the union of the given decks, deduped by UUID so an
 * adversary sitting in two selected decks is not twice as likely to appear.
 *
 * @param {string[]} deckIds Selected deck ids.
 * @returns {Promise<object[]>} Hydrated adversaries.
 */
export async function resolvePool(deckIds) {
    const seen = new Set();
    const pool = [];
    for (const id of deckIds ?? []) {
        for (const entry of await resolveDeck(id)) {
            if (seen.has(entry.uuid)) continue;
            seen.add(entry.uuid);
            pool.push(entry);
        }
    }
    return pool;
}
