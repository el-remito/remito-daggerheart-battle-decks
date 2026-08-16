/**
 * Deck persistence — the sole read/write path for the deck catalogue.
 *
 * UI code must never call game.settings for decks directly; route everything through here so
 * validation, GM gating and cache invalidation happen in exactly one place. (Same discipline as
 * remito-reputation-tracker's data-manager.js.)
 *
 * Stored shape, across two world settings:
 *   `decks`       [{ id, name, uuids: string[], folderId: string|null, tags: string[], sort: number }]
 *   `deckFolders` [{ id, name, parentId: string|null, tags: string[], sort: number, collapsed?: true }]
 *
 * Only UUIDs are stored, never copies of the actor. A deck can therefore mix world actors and
 * compendium adversaries, and edits to an adversary are picked up automatically.
 *
 * ORGANISATION
 * ------------
 * Two flat arrays, not a nested tree. The tree is derived on read, which is how Foundry models its
 * own Folder documents and is what keeps a move to a single `parentId` write rather than a splice
 * through two levels of nesting. It also means a corrupt or orphaned parent is a survivable read
 * bug rather than a lost deck: `normalize()` reparents anything whose folder no longer exists to
 * the root, exactly as the builder prunes deck ids that no longer resolve.
 *
 * `sort` is a plain index within its own (parent, kind) sibling list, renumbered from 0 after every
 * structural change. Fractional midpoints would have been fewer writes, but the whole catalogue is
 * rewritten on every save anyway — it is one setting blob — so there is nothing to save by being
 * clever, and integers can never drift into needing a rebalance.
 *
 * Folders always sort above decks within the same parent, per Foundry's own sidebar. That is why
 * sibling lists are per-kind: a deck can never be dragged above a folder, so the two orderings
 * never have to be reconciled.
 */

import {
    MODULE_ID,
    SETTINGS,
    ADVERSARY_TYPE,
    NS,
    MAX_FOLDER_DEPTH
} from '../config/constants.mjs';

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

/* -------------------------------------------- */
/*  Normalisation                               */
/* -------------------------------------------- */

/**
 * Clean up a free-text tag list.
 *
 * Trimmed, blanks dropped, deduped case-insensitively but keeping whatever spelling the GM typed
 * first — "Demons" and "demons" are the same tag, and the first one wins rather than being
 * silently lowercased out from under them.
 *
 * @param {string[]|string} tags Array, or a comma-separated string straight from the edit dialog.
 * @returns {string[]}
 */
export function normalizeTags(tags) {
    const list = Array.isArray(tags) ? tags : String(tags ?? '').split(',');
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        const tag = String(raw ?? '').trim();
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

/**
 * Compare two names the way a GM would file them: case-insensitively, and with runs of digits
 * compared as numbers so "Deck 2" files before "Deck 10" rather than after it.
 */
function byName(a, b) {
    return String(a?.name ?? '').localeCompare(String(b?.name ?? ''), undefined, {
        numeric: true,
        sensitivity: 'base'
    });
}

/**
 * Fill in the fields a record written by an older version will not have, and repair anything that
 * cannot be rendered.
 *
 * Read-time rather than a migration pass: a 1.0.x world has decks with no `folderId`, `tags` or
 * `sort` at all, and normalising here means such a world works untouched — the missing fields
 * materialise on the next write, and never having run a migration means never having to reason
 * about a half-migrated blob.
 *
 * @param {object[]} entries   Raw records from the setting.
 * @param {string}   parentKey `folderId` for decks, `parentId` for folders.
 * @param {Set<string>} validParents Ids of folders that actually exist.
 * @returns {object[]}
 */
function normalize(entries, parentKey, validParents) {
    return entries
        .filter(entry => entry && typeof entry.id === 'string')
        .map((entry, index) => {
            const parent = entry[parentKey] ?? null;
            return {
                ...entry,
                name: String(entry.name ?? ''),
                // A folder deleted out from under this record — or a blob from a world where it
                // never existed — puts the entry back at the root rather than losing it.
                [parentKey]: validParents.has(parent) ? parent : null,
                tags: normalizeTags(entry.tags),
                sort: Number.isFinite(entry.sort) ? entry.sort : index
            };
        });
}

/**
 * Order a normalised list so that filtering it by parent yields that parent's children in their
 * intended order. Sorting globally by `sort` is enough for that, because `sort` is an index within
 * a sibling list; the name tiebreak only matters for records that predate `sort` entirely.
 */
function bySort(a, b) {
    return a.sort - b.sort || byName(a, b);
}

/* -------------------------------------------- */
/*  Folders                                     */
/* -------------------------------------------- */

/** @returns {object[]} Raw folder records, normalised. Order is not meaningful; use the filters. */
function readFolders() {
    const raw = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.DECK_FOLDERS) ?? []);
    const ids = new Set(raw.filter(folder => folder?.id).map(folder => folder.id));
    // A folder may not be its own parent. Deeper cycles are broken by the depth cap in walk().
    const folders = normalize(raw, 'parentId', ids).map(folder =>
        folder.parentId === folder.id ? { ...folder, parentId: null } : folder
    );
    return folders.sort(bySort);
}

/**
 * Depth-first walk of the tree, folders before decks at every level.
 *
 * The depth cap is the cycle guard: two folders each claiming the other as parent are unreachable
 * from the root and simply never emitted, and `getFolders()` re-attaches whatever the walk missed
 * so a corrupt blob still shows every folder rather than quietly hiding some.
 *
 * @param {object[]} folders Normalised folders.
 * @param {object[]} decks   Normalised decks.
 * @param {(entry: object, kind: 'folder'|'deck', depth: number) => void} visit
 */
function walk(folders, decks, visit) {
    const seen = new Set();
    const descend = (parentId, depth) => {
        if (depth > MAX_FOLDER_DEPTH) return;
        for (const folder of folders.filter(entry => entry.parentId === parentId)) {
            if (seen.has(folder.id)) continue;
            seen.add(folder.id);
            visit(folder, 'folder', depth);
            descend(folder.id, depth + 1);
        }
        for (const deck of decks.filter(entry => entry.folderId === parentId)) {
            visit(deck, 'deck', depth);
        }
    };
    descend(null, 0);
    return seen;
}

/**
 * @returns {object[]} All folders, in tree order (a folder immediately followed by its subtree).
 *                     Always a fresh copy.
 */
export function getFolders() {
    const folders = readFolders();
    const ordered = [];
    const reached = walk(folders, [], folder => ordered.push(folder));
    // Anything the walk could not reach was in a cycle. Show it at the end rather than losing it.
    for (const folder of folders) if (!reached.has(folder.id)) ordered.push(folder);
    return ordered;
}

/**
 * @param {string} id Folder id.
 * @returns {object|undefined}
 */
export function getFolder(id) {
    return readFolders().find(folder => folder.id === id);
}

/**
 * @param {string|null} folderId
 * @returns {string} Human-readable path, e.g. "Demons / Lesser". Empty string at the root.
 */
export function folderPath(folderId) {
    const folders = readFolders();
    const names = [];
    let current = folders.find(folder => folder.id === folderId);
    let guard = 0;
    while (current && guard++ < MAX_FOLDER_DEPTH) {
        names.unshift(current.name);
        current = folders.find(folder => folder.id === current.parentId);
    }
    return names.join(' / ');
}

/* -------------------------------------------- */
/*  Decks                                       */
/* -------------------------------------------- */

/** @returns {object[]} Normalised decks in storage order — the internal, pre-tree-order view. */
function readDecks() {
    const raw = foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.DECKS) ?? []);
    const folderIds = new Set(readFolders().map(folder => folder.id));
    return normalize(raw, 'folderId', folderIds).sort(bySort);
}

/**
 * @returns {object[]} All decks, in tree order — grouped under their folders, exactly as the Deck
 *                     Editor's rail shows them. Always a fresh copy; callers may mutate it freely.
 */
export function getDecks() {
    const folders = readFolders();
    const decks = readDecks();
    const ordered = [];
    walk(folders, decks, (entry, kind) => {
        if (kind === 'deck') ordered.push(entry);
    });
    // A deck inside an unreachable (cyclic) folder is still a deck. Append rather than drop it.
    const shown = new Set(ordered.map(deck => deck.id));
    for (const deck of decks) if (!shown.has(deck.id)) ordered.push(deck);
    return ordered;
}

/**
 * @param {string} id Deck id.
 * @returns {object|undefined} The deck, or undefined if it no longer exists.
 */
export function getDeck(id) {
    return readDecks().find(deck => deck.id === id);
}

/**
 * The flat row list the Deck Editor renders: folders and decks interleaved in tree order, each
 * carrying its own indentation depth.
 *
 * Flat rather than nested because every row is then a DOM sibling, which is what makes the
 * reorder drop maths ("above this row / below this row / into this folder") a single
 * `getBoundingClientRect` against whatever the pointer is over. A nested `<ul>` would have needed
 * a recursive partial and hit-testing through the nesting.
 *
 * A collapsed folder still appears; its subtree does not.
 *
 * @returns {object[]} [{ kind: 'folder'|'deck', depth, ...record, deckCount }]
 */
export function deckTreeRows() {
    const folders = readFolders();
    const decks = readDecks();

    // Decks in a folder, counted through its subfolders too, so a collapsed folder still says how
    // much is inside it.
    const deckCount = (folderId, depth = 0) => {
        if (depth > MAX_FOLDER_DEPTH) return 0;
        let total = decks.filter(deck => deck.folderId === folderId).length;
        for (const child of folders.filter(folder => folder.parentId === folderId)) {
            total += deckCount(child.id, depth + 1);
        }
        return total;
    };

    const rows = [];
    const descend = (parentId, depth) => {
        if (depth > MAX_FOLDER_DEPTH) return;
        for (const folder of folders.filter(entry => entry.parentId === parentId)) {
            rows.push({ ...folder, kind: 'folder', depth, deckCount: deckCount(folder.id) });
            if (!folder.collapsed) descend(folder.id, depth + 1);
        }
        for (const deck of decks.filter(entry => entry.folderId === parentId)) {
            rows.push({ ...deck, kind: 'deck', depth, count: deck.uuids?.length ?? 0 });
        }
    };
    descend(null, 0);
    return rows;
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

/** @param {object[]} folders Full replacement folder list. */
async function saveFolders(folders) {
    await game.settings.set(MODULE_ID, SETTINGS.DECK_FOLDERS, folders);
}

/* -------------------------------------------- */
/*  Ordering                                    */
/* -------------------------------------------- */

/**
 * Put `entry` at its place among its new siblings and renumber the whole sibling run.
 *
 * `entry` must already be a member of `list` — the siblings this renumbers are live references
 * into it, which is what makes one `save(list)` afterwards enough.
 *
 * @param {object[]} list      Every record of the entry's kind.
 * @param {object}   entry     The record being placed.
 * @param {string}   parentKey `folderId` for decks, `parentId` for folders.
 * @param {string|null} parentId Destination parent.
 * @param {object}   [options]
 * @param {string|null} [options.anchorId]  Sibling to sit next to; null for alphabetical.
 * @param {'before'|'after'|'alphabetical'} [options.placement]
 */
function place(list, entry, parentKey, parentId, { anchorId = null, placement = 'alphabetical' } = {}) {
    entry[parentKey] = parentId ?? null;

    const siblings = list.filter(
        other => other.id !== entry.id && (other[parentKey] ?? null) === (parentId ?? null)
    );

    let index;
    if (anchorId && (placement === 'before' || placement === 'after')) {
        const at = siblings.findIndex(other => other.id === anchorId);
        index = at < 0 ? siblings.length : placement === 'before' ? at : at + 1;
    } else {
        // Alphabetical: the first sibling this one sorts ahead of. A brand new deck therefore
        // files itself, while anything the GM has since dragged keeps the position they gave it.
        index = siblings.findIndex(sibling => byName(entry, sibling) < 0);
        if (index < 0) index = siblings.length;
    }

    siblings.splice(index, 0, entry);
    siblings.forEach((sibling, position) => {
        sibling.sort = position;
    });
}

/** Close the gaps left in a sibling run after something was moved out of it. */
function renumber(list, parentKey, parentId) {
    list.filter(entry => (entry[parentKey] ?? null) === (parentId ?? null))
        .sort(bySort)
        .forEach((entry, index) => {
            entry.sort = index;
        });
}

/**
 * Would parenting `folderId` under `destinationId` make a folder its own ancestor?
 *
 * The one move that has to be refused outright: the subtree would detach from the root and every
 * deck in it would vanish from the rail.
 */
function wouldCycle(folders, folderId, destinationId) {
    let current = destinationId;
    let guard = 0;
    while (current && guard++ <= MAX_FOLDER_DEPTH) {
        if (current === folderId) return true;
        current = folders.find(folder => folder.id === current)?.parentId ?? null;
    }
    return false;
}

/**
 * Move a deck or folder somewhere else in the tree.
 *
 * Three destinations, matching the three things the Deck Editor lets you drop on:
 *   - `{ parentId }`                          — into that folder (or the root), filed alphabetically
 *   - `{ relativeTo, placement: 'before' }`   — immediately above that row
 *   - `{ relativeTo, placement: 'after' }`    — immediately below it
 *
 * `relativeTo` also supplies the destination parent, which is what makes dropping between two rows
 * inside a folder land inside that folder. An anchor of the *other* kind still sets the parent but
 * cannot order against it — folders and decks keep separate sibling runs — so that degrades to
 * alphabetical, which is the only sensible reading of "put this folder after that deck".
 *
 * @param {'deck'|'folder'} kind
 * @param {string} id
 * @param {object} [target]
 * @param {string|null} [target.parentId]
 * @param {{kind: 'deck'|'folder', id: string}|null} [target.relativeTo]
 * @param {'before'|'after'|'alphabetical'} [target.placement]
 * @returns {Promise<boolean>} True when something moved.
 */
export async function moveEntry(kind, id, { parentId = null, relativeTo = null, placement = 'alphabetical' } = {}) {
    if (!assertGM()) return false;

    const isFolder = kind === 'folder';
    const parentKey = isFolder ? 'parentId' : 'folderId';
    const list = isFolder ? readFolders() : readDecks();
    const entry = list.find(record => record.id === id);
    if (!entry) return false;

    let destination = parentId ?? null;
    let anchorId = null;

    if (relativeTo?.id) {
        const anchor =
            relativeTo.kind === 'folder'
                ? readFolders().find(folder => folder.id === relativeTo.id)
                : readDecks().find(deck => deck.id === relativeTo.id);
        if (!anchor) return false;
        if (relativeTo.kind === kind && relativeTo.id === id) return false; // dropped on itself
        destination = (relativeTo.kind === 'folder' ? anchor.parentId : anchor.folderId) ?? null;
        if (relativeTo.kind === kind) anchorId = relativeTo.id;
    }

    if (isFolder && wouldCycle(list, id, destination)) {
        ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.folderCycle`));
        return false;
    }

    const previous = entry[parentKey] ?? null;
    place(list, entry, parentKey, destination, { anchorId, placement });
    if (previous !== destination) renumber(list, parentKey, previous);

    if (isFolder) await saveFolders(list);
    else await save(list);
    return true;
}

/* -------------------------------------------- */
/*  Folder CRUD                                 */
/* -------------------------------------------- */

/**
 * @param {string} [name]     Folder name; falls back to a localized default.
 * @param {string|null} [parentId] Folder to nest inside.
 * @returns {Promise<object|null>} The created folder.
 */
export async function createFolder(name, parentId = null) {
    if (!assertGM()) return null;
    const folders = readFolders();
    const folder = {
        id: foundry.utils.randomID(),
        name: name?.trim() || game.i18n.localize(`${NS}.Deck.newFolderName`),
        parentId: null,
        tags: [],
        sort: 0
    };
    folders.push(folder);
    place(folders, folder, 'parentId', folders.some(entry => entry.id === parentId) ? parentId : null);
    await saveFolders(folders);
    return folder;
}

/**
 * Rename a folder and/or replace its tags. A blank name is ignored rather than applied — an
 * unnamed folder is unclickable in the rail.
 *
 * Renaming deliberately does **not** re-file the folder alphabetically: alphabetical order is the
 * starting position for something new, and re-sorting on rename would throw away an order the GM
 * arranged by hand.
 *
 * @param {string} id
 * @param {{name?: string, tags?: string[]|string}} changes
 */
export async function updateFolder(id, changes = {}) {
    if (!assertGM()) return;
    const folders = readFolders();
    const folder = folders.find(entry => entry.id === id);
    if (!folder) return;

    const name = changes.name?.trim();
    if (name) folder.name = name;
    if (changes.tags !== undefined) folder.tags = normalizeTags(changes.tags);

    await saveFolders(folders);
}

/** Expand or collapse a folder. Stored on the folder so the shape of the rail survives a reload. */
export async function toggleFolder(id) {
    if (!assertGM()) return;
    const folders = readFolders();
    const folder = folders.find(entry => entry.id === id);
    if (!folder) return;
    // Stored only while collapsed, so an untouched folder carries no key at all.
    if (folder.collapsed) delete folder.collapsed;
    else folder.collapsed = true;
    await saveFolders(folders);
}

/**
 * Delete a folder.
 *
 * The default promotes everything inside it up to the folder's own parent, because deleting a
 * folder and deleting six decks are very different intentions and only one of them is recoverable.
 * `cascade` is the explicit second choice offered by the confirm dialog.
 *
 * @param {string} id
 * @param {object} [options]
 * @param {boolean} [options.cascade] Delete the whole subtree, decks included.
 */
export async function deleteFolder(id, { cascade = false } = {}) {
    if (!assertGM()) return;

    const folders = readFolders();
    const decks = readDecks();
    const folder = folders.find(entry => entry.id === id);
    if (!folder) return;

    if (cascade) {
        const doomed = new Set([id]);
        for (let depth = 0; depth <= MAX_FOLDER_DEPTH; depth += 1) {
            for (const entry of folders) {
                if (doomed.has(entry.parentId)) doomed.add(entry.id);
            }
        }
        await saveFolders(folders.filter(entry => !doomed.has(entry.id)));
        await save(decks.filter(deck => !doomed.has(deck.folderId)));
        return;
    }

    const parentId = folder.parentId ?? null;
    const survivors = folders.filter(entry => entry.id !== id);

    // Promote in tree order so the children keep their relative arrangement as they file into the
    // destination alphabetically.
    for (const child of survivors.filter(entry => entry.parentId === id).sort(bySort)) {
        place(survivors, child, 'parentId', parentId);
    }
    for (const deck of decks.filter(entry => entry.folderId === id).sort(bySort)) {
        place(decks, deck, 'folderId', parentId);
    }

    await saveFolders(survivors);
    await save(decks);
}

/* -------------------------------------------- */
/*  Deck CRUD                                   */
/* -------------------------------------------- */

/**
 * @param {string} [name]         Deck name; falls back to a localized default.
 * @param {string|null} [folderId] Folder to create it in.
 * @returns {Promise<object|null>} The created deck.
 */
export async function createDeck(name, folderId = null) {
    if (!assertGM()) return null;
    const decks = readDecks();
    const folders = readFolders();
    const deck = {
        id: foundry.utils.randomID(),
        name: name?.trim() || game.i18n.localize(`${NS}.Deck.newDeckName`),
        uuids: [],
        folderId: null,
        tags: [],
        sort: 0
    };
    decks.push(deck);
    place(decks, deck, 'folderId', folders.some(folder => folder.id === folderId) ? folderId : null);
    await save(decks);
    return deck;
}

/**
 * Rename a deck and/or replace its tags. Same no-re-sort rule as {@link updateFolder}.
 *
 * @param {string} id
 * @param {{name?: string, tags?: string[]|string}} changes
 */
export async function updateDeck(id, changes = {}) {
    if (!assertGM()) return;
    const decks = readDecks();
    const deck = decks.find(entry => entry.id === id);
    if (!deck) return;

    const name = changes.name?.trim();
    if (name) deck.name = name;
    if (changes.tags !== undefined) deck.tags = normalizeTags(changes.tags);

    await save(decks);
}

/**
 * @param {string} id   Deck id.
 * @param {string} name New name; blank names are ignored.
 */
export async function renameDeck(id, name) {
    await updateDeck(id, { name });
}

/** @param {string} id Deck id. */
export async function deleteDeck(id) {
    if (!assertGM()) return;
    const decks = readDecks();
    const deck = decks.find(entry => entry.id === id);
    if (!deck) return;
    const survivors = decks.filter(entry => entry.id !== id);
    renumber(survivors, 'folderId', deck.folderId ?? null);
    await save(survivors);
}

/**
 * Everything about a deck a search box should be able to match on: its name, its tags, and the
 * folders it lives in. Tags are only worth applying if they can be searched for, and the builder's
 * deck picker is where "find the one I want" actually happens.
 *
 * @param {object} deck
 * @returns {string} Lowercased haystack.
 */
export function deckSearchText(deck) {
    return [deck?.name ?? '', ...(deck?.tags ?? []), folderPath(deck?.folderId)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
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

    const decks = readDecks();
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
    const decks = readDecks();
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
 * How many adversaries each deck can actually produce.
 *
 * Not `uuids.length`. A deck keeps the UUID of an adversary whose actor has been deleted — see
 * `resolveAdversary`, which leaves it in place so that re-enabling a compendium restores the deck
 * intact — so the stored list is a record of intent, not a count of what is there. Rendering the
 * raw length gave the rail a badge that disagreed with the pane beside it and never came back down
 * after a deletion.
 *
 * Resolved in one pass over the union of every deck's UUIDs, so an adversary sitting in six decks
 * is fetched once, and everything after the first call is served from `resolvedCache`.
 *
 * @returns {Promise<Map<string, number>>} Deck id → count of adversaries that still resolve.
 */
export async function resolvedCounts() {
    const decks = readDecks();
    const uuids = [...new Set(decks.flatMap(deck => deck.uuids ?? []))];

    const alive = new Set();
    await Promise.all(
        uuids.map(async uuid => {
            if (await resolveAdversary(uuid)) alive.add(uuid);
        })
    );

    const counts = new Map();
    for (const deck of decks) {
        counts.set(deck.id, (deck.uuids ?? []).filter(uuid => alive.has(uuid)).length);
    }
    return counts;
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
