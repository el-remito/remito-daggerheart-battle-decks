/**
 * Shared identifiers for Remito's Battle Decks.
 *
 * Kept as bare exported constants rather than one wrapper object, matching the
 * convention in remito-heroic-skill-tree and daggerheart-vessel-sheet.
 */

export const MODULE_ID = 'remito-daggerheart-battle-decks';

/** Localization namespace. Every user-facing string lives under this prefix in lang/en.json. */
export const NS = 'RDBD';

/** Actor sub-type this module will accept into a deck. */
export const ADVERSARY_TYPE = 'adversary';

/**
 * World setting keys. All access goes through module/data/decks.mjs, config/settings.mjs or
 * config/adversary-types.mjs.
 *
 * None of these are shown in the Settings tab. Party tier and size deliberately have no setting
 * at all: the Battle Encounters window is their only source of truth, and the ENCOUNTER blob is
 * what remembers them between sessions.
 */
export const SETTINGS = {
    DECKS: 'decks',
    DECK_FOLDERS: 'deckFolders',
    ENCOUNTER: 'encounter',
    TYPE_COSTS: 'typeCosts',
    AUTO_COLLAPSE: 'autoCollapseSetup'
};

/**
 * How deep the folder tree may nest. Not a design limit so much as a cycle guard: a corrupt
 * `parentId` chain would otherwise recurse forever while flattening the tree for rendering.
 */
export const MAX_FOLDER_DEPTH = 12;

/**
 * `type` carried by the Deck Editor's own reorder drags, distinguishing them from the
 * `{ type: "Actor" }` payload the sidebar and compendiums emit. Both land in the same drop handler.
 */
export const MOVE_DRAG_TYPE = 'rdbd-move';

/** Settings-tab submenus. The only entry this module puts in Game Settings. */
export const MENUS = {
    TYPE_COSTS: 'typeCostsMenu'
};

export const TEMPLATES = {
    BUILDER: `modules/${MODULE_ID}/templates/encounter-builder.hbs`,
    DECK_EDITOR: `modules/${MODULE_ID}/templates/deck-editor.hbs`,
    TYPE_COSTS: `modules/${MODULE_ID}/templates/type-costs.hbs`,
    ADVERSARY_CARD: `modules/${MODULE_ID}/templates/partials/adversary-card.hbs`,
    DECK_ROW: `modules/${MODULE_ID}/templates/partials/deck-row.hbs`,
    BP_SUMMARY: `modules/${MODULE_ID}/templates/partials/bp-summary.hbs`
};

/**
 * Key added to canvas drag data so our own drop handler can recognise a stacked card
 * and place more than one token. Namespaced to avoid colliding with core/system keys.
 */
export const DRAG_QUANTITY_KEY = 'rdbdQuantity';

/**
 * Key added to canvas drag data identifying which card was dragged, so the drop handler can mark
 * that card as spawned. Namespaced for the same reason as DRAG_QUANTITY_KEY.
 */
export const DRAG_CARD_KEY = 'rdbdCardKey';

/** Window ids. Both apps are singletons, looked up in foundry.applications.instances. */
export const APP_IDS = {
    BUILDER: 'rdbd-encounter-builder',
    DECK_EDITOR: 'rdbd-deck-editor',
    TYPE_COSTS: 'rdbd-type-costs'
};

/** Generation modes offered by the single Generate button. */
export const GENERATION_MODE = {
    BUDGET: 'budget',
    FREE: 'free'
};

/** Hard stop for the draw loop so a pathological deck can never hang the client. */
export const MAX_DRAW_ITERATIONS = 200;
