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
        onChange: refreshOpenWindows
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
