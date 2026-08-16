/**
 * World setting registration.
 *
 * The module deliberately puts almost nothing in the Settings tab. Party tier and size are not
 * settings at all — the Battle Encounters window owns them, and the `encounter` blob remembers
 * what the GM last typed. Duplicating them here would have given two places to change the same
 * number, which is exactly the sort of thing that goes stale.
 *
 * The one Settings-tab entry is the Adversary BP Costs menu, which exists because the system has
 * nowhere to record a cost for a homebrew adversary type. See config/adversary-types.mjs.
 *
 * Nothing outside this file, module/data/decks.mjs and module/config/adversary-types.mjs should
 * call game.settings directly.
 */

import { MODULE_ID, NS, SETTINGS, MENUS } from './constants.mjs';
import { TypeCostEditor } from '../apps/type-costs.mjs';
import { refreshOpenWindows } from '../ui/refresh.mjs';
import { invalidateCache } from '../data/decks.mjs';
import { invalidateTypeCache } from './adversary-types.mjs';

const fields = foundry.data.fields;

export function registerSettings() {
    // Deck catalogue: [{ id, name, uuids: [] }]. Managed exclusively through the Deck Editor.
    //
    // onChange is what keeps the two windows in step: creating or renaming a deck in the editor
    // has to reach the builder's deck picker straight away, and it fires for remote GMs too.
    game.settings.register(MODULE_ID, SETTINGS.DECKS, {
        scope: 'world',
        config: false,
        type: new fields.ArrayField(new fields.ObjectField()),
        default: [],
        onChange: () => {
            invalidateCache();
            refreshOpenWindows();
        }
    });

    // Folder tree for the deck catalogue: [{ id, name, parentId, tags, sort, collapsed? }].
    //
    // A second setting rather than nesting decks inside folders, so that moving a deck writes one
    // `folderId` instead of splicing it out of one nested array and into another — and so a folder
    // record that goes bad can never take its decks down with it. See module/data/decks.mjs.
    game.settings.register(MODULE_ID, SETTINGS.DECK_FOLDERS, {
        scope: 'world',
        config: false,
        type: new fields.ArrayField(new fields.ObjectField()),
        default: [],
        onChange: () => {
            invalidateCache();
            refreshOpenWindows();
        }
    });

    // Last generated or accepted encounter, plus the builder inputs that produced it — party tier
    // and size included. This is what makes those two fields stick between sessions.
    game.settings.register(MODULE_ID, SETTINGS.ENCOUNTER, {
        scope: 'world',
        config: false,
        type: new fields.ObjectField(),
        default: {}
    });

    // Adversary type cost overrides: [{ id, bpCost?, partyAmountPerBP? }].
    // An array rather than a keyed object so that removing an override actually removes it —
    // writing an object setting merges rather than replaces.
    game.settings.register(MODULE_ID, SETTINGS.TYPE_COSTS, {
        scope: 'world',
        config: false,
        type: new fields.ArrayField(new fields.ObjectField()),
        default: [],
        onChange: () => {
            // The merged type table is memoized (see config/adversary-types.mjs). This setting is
            // one of the two things that can change it, so it must be dropped here or every cost
            // in the module stays at its previous value until the world reloads.
            invalidateTypeCache();
            refreshOpenWindows();
        }
    });

    // The one checkbox this module puts in the Settings tab.
    //
    // `client`, not `world`: it decides how one person's window behaves and says nothing about the
    // game. Two GMs at the same table should not be able to change each other's view. This is not
    // a contradiction of the note above about party tier and size — those are *encounter data*
    // that already had a home, whereas a view preference has nowhere else to live.
    game.settings.register(MODULE_ID, SETTINGS.AUTO_COLLAPSE, {
        name: `${NS}.Settings.autoCollapse.name`,
        hint: `${NS}.Settings.autoCollapse.hint`,
        scope: 'client',
        config: true,
        // A bare Boolean, not a BooleanField: this is the one setting Foundry renders itself, and
        // the primitive constructor is what makes it a checkbox. The fields.* types above are there
        // because those settings hold arrays of objects, not because the file has a house style.
        type: Boolean,
        default: true
    });

    game.settings.registerMenu(MODULE_ID, MENUS.TYPE_COSTS, {
        name: `${NS}.TypeCosts.menuName`,
        label: `${NS}.TypeCosts.menuLabel`,
        hint: `${NS}.TypeCosts.menuHint`,
        icon: 'fa-solid fa-coins',
        type: TypeCostEditor,
        restricted: true
    });
}
