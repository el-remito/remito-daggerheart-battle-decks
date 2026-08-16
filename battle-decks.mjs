/**
 * Remito's Battle Decks — entry point.
 *
 * Build named decks of Daggerheart adversaries, then roll random battle encounters from them
 * sized by the Valiran Battle Points homebrew. GM-only throughout.
 *
 * No build step: this file and everything under module/ are plain ES modules loaded directly by
 * Foundry, matching the rest of the remito module family.
 */

import { MODULE_ID, TEMPLATES } from './module/config/constants.mjs';
import { registerSettings } from './module/config/settings.mjs';
import { registerSidebarButton } from './module/ui/sidebar-button.mjs';
import { registerCanvasDrop } from './module/helpers/canvas-drop.mjs';
import { EncounterBuilder, openEncounterBuilder } from './module/apps/encounter-builder.mjs';
import { DeckEditor, openDeckEditor, registerDeckEditorHooks } from './module/apps/deck-editor.mjs';
import { TypeCostEditor, openTypeCosts } from './module/apps/type-costs.mjs';
import * as AdversaryTypes from './module/config/adversary-types.mjs';
import * as Decks from './module/data/decks.mjs';
import * as BP from './module/helpers/bp.mjs';
import * as Generator from './module/helpers/generator.mjs';

Hooks.once('init', () => {
    registerSettings();
    registerSidebarButton();
    registerCanvasDrop();
    registerDeckEditorHooks();

    // The merged adversary type table is memoized (config/adversary-types.mjs) because it sits in
    // the generator's innermost loop. Its own setting drops the cache from that setting's onChange;
    // this catches the other input — the *system's* homebrew adversary types, which a GM edits
    // through Daggerheart's own settings and which this module has no onChange of its own for.
    // Deliberately unfiltered: dropping a memo is far cheaper than working out whose setting it was.
    Hooks.on('updateSetting', () => AdversaryTypes.invalidateTypeCache());

    // Object form registers each template as a named partial, which is how the .hbs files
    // reference them ({{> rdbdAdversaryCard}} and friends).
    foundry.applications.handlebars.loadTemplates({
        rdbdAdversaryCard: TEMPLATES.ADVERSARY_CARD,
        rdbdDeckRow: TEMPLATES.DECK_ROW,
        rdbdBpSummary: TEMPLATES.BP_SUMMARY
    });
});

Hooks.once('ready', () => {
    // Warn rather than fail: the module still loads, but every BP cost would come back as 0,
    // because the adversary type table is resolved from the Daggerheart system.
    if (game.system.id !== 'daggerheart') {
        console.warn(`${MODULE_ID} | The Daggerheart system is not active; Battle Decks is inert.`);
        return;
    }

    // Console/macro surface, per the house convention. selfTest() re-runs the worked example
    // from the source spreadsheet and is the fastest way to confirm the rules still hold after
    // any change to the BP tables.
    const module = game.modules.get(MODULE_ID);
    if (module) {
        module.api = {
            openEncounterBuilder,
            openDeckEditor,
            openTypeCosts,
            EncounterBuilder,
            DeckEditor,
            TypeCostEditor,
            decks: Decks,
            bp: BP,
            generator: Generator,
            adversaryTypes: AdversaryTypes,
            selfTest: BP.selfTest
        };
    }
});
