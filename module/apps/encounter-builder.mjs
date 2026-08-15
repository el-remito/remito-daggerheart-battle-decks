/**
 * Battle Encounters — the module's main window.
 *
 * Top half is the builder (party, decks, modifiers, mode); bottom half is the generated roster.
 * Cards can be clicked to open the adversary sheet and dragged onto the canvas to spawn tokens.
 *
 * All state lives in the `encounter` world setting so an encounter survives a reload and comes
 * back exactly as the GM left it — which is what makes "Accept" meaningful.
 */

import {
    MODULE_ID,
    NS,
    SETTINGS,
    TEMPLATES,
    APP_IDS,
    GENERATION_MODE,
    DRAG_QUANTITY_KEY,
    DRAG_CARD_KEY
} from '../config/constants.mjs';
import {
    defaultModifiers,
    SELECT_MODIFIERS,
    MAX_EXTRA_DAMAGE_DICE,
    TIER_RANGE,
    PARTY_SIZE_RANGE,
    PARTY_DEFAULTS
} from '../config/bp-tables.mjs';
import * as Decks from '../data/decks.mjs';
import { expectedBudget } from '../helpers/bp.mjs';
import {
    generate,
    drawOne,
    rerollCard,
    putBack,
    decorateCards,
    budgetFor
} from '../helpers/generator.mjs';
import { openDeckEditor } from './deck-editor.mjs';
import { openTypeCosts } from './type-costs.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * A blank encounter.
 *
 * Party tier and size are first-run defaults only: this window is their single source of truth,
 * and #update() writes whatever the GM types straight back into the `encounter` setting, so the
 * next time the window opens it comes up with their numbers rather than these.
 */
function blankState() {
    return {
        ...PARTY_DEFAULTS,
        deckIds: [],
        modifiers: defaultModifiers(),
        mode: GENERATION_MODE.BUDGET,
        targetBP: null,
        drawCount: 3,
        cards: [],
        // Card keys already dragged onto the canvas, so the GM can see at a glance what is still
        // waiting to be placed. Cleared whenever the roster is redrawn.
        spawned: [],
        locked: false,
        generated: false
    };
}

/** How many rows the deck multi-select shows before it starts scrolling. */
const DECK_SELECT_ROWS = { min: 3, max: 8 };

export class EncounterBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: APP_IDS.BUILDER,
        classes: ['daggerheart', 'dh-style', 'rdbd-app', 'rdbd-builder'],
        tag: 'form',
        window: {
            frame: true,
            positioned: true,
            title: `${NS}.Builder.title`,
            icon: 'fa-solid fa-swords',
            minimizable: true,
            resizable: true
        },
        position: { width: 820, height: 760 },
        form: { handler: EncounterBuilder.#onChangeForm, submitOnChange: true, closeOnSubmit: false },
        actions: {
            generate: EncounterBuilder.#onGenerate,
            drawOne: EncounterBuilder.#onDrawOne,
            accept: EncounterBuilder.#onAccept,
            unlock: EncounterBuilder.#onUnlock,
            reroll: EncounterBuilder.#onRerollAll,
            reset: EncounterBuilder.#onReset,
            rerollCard: EncounterBuilder.#onRerollCard,
            putBack: EncounterBuilder.#onPutBack,
            openCard: EncounterBuilder.#onOpenCard,
            openDecks: EncounterBuilder.#onOpenDecks,
            openCosts: EncounterBuilder.#onOpenCosts
        }
    };

    static PARTS = { main: { template: TEMPLATES.BUILDER } };

    /** @type {foundry.applications.ux.DragDrop|null} */
    #dragDrop = null;

    /** @override */
    render(options) {
        if (!game.user.isGM) {
            ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.gmOnly`));
            return this;
        }
        return super.render(options);
    }

    /** @returns {object} The persisted encounter state, backfilled with any missing keys. */
    get state() {
        const stored = game.settings.get(MODULE_ID, SETTINGS.ENCOUNTER);
        return foundry.utils.mergeObject(blankState(), stored ?? {}, { inplace: false });
    }

    /**
     * @param {object} changes Partial state to merge and persist.
     */
    async #update(changes) {
        const next = foundry.utils.mergeObject(this.state, changes, { inplace: false });
        await game.settings.set(MODULE_ID, SETTINGS.ENCOUNTER, next);
        this.render(false);
    }

    /**
     * Turn a lookup table into the { value, label, hint, selected } rows a <select> needs.
     *
     * Option labels carry no BP value: the dropdown says "High", not "High (+1)". What each choice
     * is actually worth shows up in the Battle Points panel, where every contributing modifier is
     * listed with its number — one place to read the arithmetic instead of it being scattered
     * across four controls.
     *
     * Labels are also kept short, because the spreadsheet's own wording ("Much Easier / Much
     * Faster") overflows a dropdown in a two-column layout. Where a table has a `<key>.<id>Hint`
     * string it carries the full phrasing as the option's title attribute, so nothing is lost.
     *
     * @param {string} key    Modifier key, for localization.
     * @param {object} table  Option id -> BP value.
     * @param {string} chosen Currently selected option id.
     */
    #options(key, table, chosen) {
        return Object.keys(table).map(id => {
            const hintKey = `${NS}.Modifier.${key}.${id}Hint`;
            return {
                value: id,
                label: game.i18n.localize(`${NS}.Modifier.${key}.${id}`),
                hint: game.i18n.has?.(hintKey) ? game.i18n.localize(hintKey) : '',
                selected: id === chosen
            };
        });
    }

    /**
     * Every modifier currently moving the budget, for the Battle Points panel.
     *
     * The four dropdowns and the two number fields appear only when they are worth something, so
     * the list stays short and reads as "here is where your budget went". The two
     * composition-driven rows are always shown: their counts explain the roster even when the
     * modifier itself is 0, which is exactly when a GM wants to know why.
     *
     * @param {object} state  Encounter state.
     * @param {object} budget Output of computeBudget().
     * @returns {object[]} { label, detail, value, derived } rows.
     */
    #modifierRows(state, budget) {
        const rows = [];
        const label = key => game.i18n.localize(`${NS}.Modifier.${key}.label`);

        for (const row of SELECT_MODIFIERS) {
            const value = budget.gm[row.key];
            if (!value) continue;
            rows.push({
                label: label(row.key),
                detail: game.i18n.localize(`${NS}.Modifier.${row.key}.${state.modifiers[row.key]}`),
                value,
                derived: false
            });
        }

        if (budget.gm.extraDamage) {
            rows.push({
                label: label('extraDamage'),
                detail: `+${state.modifiers.extraDamageDice}d4`,
                value: budget.gm.extraDamage,
                derived: false
            });
        }

        if (budget.gm.adHoc) {
            rows.push({ label: label('adHoc'), detail: '', value: budget.gm.adHoc, derived: false });
        }

        rows.push({
            label: label('manySolos'),
            detail: `${game.i18n.localize(`${NS}.Summary.totalSolos`)}: ${budget.derived.soloCount}`,
            value: budget.derived.manySolos,
            derived: true
        });
        rows.push({
            label: label('noToughies'),
            detail: `${game.i18n.localize(`${NS}.Summary.validCounts`)}: ${budget.derived.toughieCount}`,
            value: budget.derived.noToughies,
            derived: true
        });

        return rows;
    }

    /** @override */
    async _prepareContext() {
        const state = this.state;
        const budget = budgetFor(state);
        const decks = Decks.getDecks();
        const spawned = state.spawned ?? [];

        return {
            state,
            budget,
            overBudget: budget.budgetLeft < 0,
            modifierRows: this.#modifierRows(state, budget),
            // What the encounter would get to spend with Target BP left blank; shown as that
            // field's placeholder so the GM can see the number they are choosing not to override.
            expectedBP: expectedBudget(state),
            cards: decorateCards(state.cards, state).map(card => ({
                ...card,
                spawned: spawned.includes(card.key)
            })),
            deckless: !state.deckIds.length,
            hasCards: (state.cards ?? []).length > 0,

            decks: decks.map(deck => ({
                ...deck,
                count: deck.uuids.length,
                selected: state.deckIds.includes(deck.id)
            })),
            hasDecks: decks.length > 0,
            // Grow with the catalogue up to a point, then scroll.
            deckSelectSize: Math.min(
                Math.max(decks.length, DECK_SELECT_ROWS.min),
                DECK_SELECT_ROWS.max
            ),

            tiers: Array.from({ length: TIER_RANGE.max - TIER_RANGE.min + 1 }, (unused, i) => {
                const value = TIER_RANGE.min + i;
                return { value, selected: value === state.partyTier };
            }),
            partySizeRange: PARTY_SIZE_RANGE,
            maxExtraDamage: MAX_EXTRA_DAMAGE_DICE,

            budgetMode: state.mode === GENERATION_MODE.BUDGET,
            modes: [
                {
                    value: GENERATION_MODE.BUDGET,
                    label: game.i18n.localize(`${NS}.Builder.modeBudget`),
                    selected: state.mode === GENERATION_MODE.BUDGET
                },
                {
                    value: GENERATION_MODE.FREE,
                    label: game.i18n.localize(`${NS}.Builder.modeFree`),
                    selected: state.mode === GENERATION_MODE.FREE
                }
            ],

            // Driven off SELECT_MODIFIERS so adding a dropdown to the rules only means adding a
            // row there plus its lang keys — nothing changes here or in the template.
            selects: SELECT_MODIFIERS.map(row => ({
                key: row.key,
                label: game.i18n.localize(`${NS}.Modifier.${row.key}.label`),
                options: this.#options(row.key, row.table, state.modifiers[row.key])
            }))
        };
    }

    /**
     * Persist every builder input on change. Locked encounters ignore input so an accepted
     * roster cannot drift out from under its BP readout.
     */
    static async #onChangeForm(event, form, formData) {
        const state = this.state;
        if (state.locked) return;

        const data = formData.object;
        const changes = {
            partyTier: Number(data.partyTier) || state.partyTier,
            pcCount: Number(data.pcCount) || state.pcCount,
            mode: data.mode ?? state.mode,
            modifiers: EncounterBuilder.#readModifiers(data, state.modifiers)
        };

        // A <select multiple> yields an array of the chosen ids, and an empty array when nothing
        // is selected — which is the deckless mode, not a missing value. The field is absent
        // entirely when there are no decks to render, hence the presence check.
        if (Array.isArray(data.deckIds)) changes.deckIds = data.deckIds;

        // Target BP and draw count are mutually exclusive in the template — only the field for
        // the active mode is rendered. Reading the absent one would wipe the value the GM set
        // last time they were in that mode, so each is only touched when it is actually present.
        if ('targetBP' in data) {
            // Blank means "use the 3 x PCs + 2 baseline". 0 is a real, respected value, and an
            // empty number input comes back as null from FormDataExtended.
            const target = Number(data.targetBP);
            changes.targetBP = data.targetBP === null || data.targetBP === '' || !Number.isFinite(target)
                ? null
                : target;
        }
        if ('drawCount' in data) {
            changes.drawCount = Math.max(1, Number(data.drawCount) || 1);
        }

        await this.#update(changes);
    }

    /**
     * Pull the modifier state out of the submitted form. Dotted field names stay flat in
     * FormDataExtended#object, so they are read as literal keys.
     *
     * @param {object} data    Flat form data.
     * @param {object} current Current modifier state, used as the fallback.
     * @returns {object}
     */
    static #readModifiers(data, current) {
        const modifiers = { ...current };
        for (const row of SELECT_MODIFIERS) {
            modifiers[row.key] = data[`modifiers.${row.key}`] ?? current[row.key];
        }
        modifiers.extraDamageDice = Number(data['modifiers.extraDamageDice']) || 0;
        modifiers.adHoc = Number(data['modifiers.adHoc']) || 0;
        return modifiers;
    }

    static async #onGenerate() {
        const state = this.state;
        if (state.locked) return;
        const cards = await generate(state);
        // A fresh roster has never been placed, so nothing is greyed out.
        await this.#update({ cards, generated: true, spawned: [] });
    }

    /**
     * Mark a card as already dragged onto the canvas. Called from the dropCanvasData handler in
     * helpers/canvas-drop.mjs, which is the only place that knows a drop actually landed.
     *
     * @param {string} key Card key.
     */
    async markSpawned(key) {
        const state = this.state;
        const spawned = state.spawned ?? [];
        if (!key || spawned.includes(key)) return;
        await this.#update({ spawned: [...spawned, key] });
    }

    static async #onRerollAll() {
        return EncounterBuilder.#onGenerate.call(this);
    }

    /**
     * Free draw only: add one more adversary without disturbing the encounter already on the
     * table. Generate throws the roster away and draws a fresh set of N, which is the wrong move
     * when the GM has spent time trimming the one they have.
     */
    static async #onDrawOne() {
        const state = this.state;
        if (state.locked) return;
        const cards = await drawOne(state);
        if (cards) await this.#update({ cards, generated: true });
    }

    static async #onAccept() {
        await this.#update({ locked: true });
    }

    static async #onUnlock() {
        await this.#update({ locked: false });
    }

    static async #onReset() {
        // Clears the roster but keeps the builder inputs, so "Reset" is not "start over".
        await this.#update({ cards: [], generated: false, locked: false, spawned: [] });
    }

    static async #onRerollCard(event, target) {
        const state = this.state;
        if (state.locked) return;

        const key = target.dataset.key;
        const cards = await rerollCard(state, key);
        if (!cards) return;

        // The slot holds a different adversary now, so whatever was placed for the old one no
        // longer describes this card. Dropping the key un-greys it.
        await this.#update({
            cards,
            spawned: (state.spawned ?? []).filter(spawnedKey => spawnedKey !== key)
        });
    }

    static async #onPutBack(event, target) {
        const state = this.state;
        if (state.locked) return;
        await this.#update({ cards: putBack(state.cards, target.dataset.key) });
    }

    static async #onOpenCard(event, target) {
        const uuid = target.dataset.uuid;
        if (!uuid) return; // deckless role card — nothing to open
        const actor = await fromUuid(uuid).catch(() => null);
        actor?.sheet?.render(true);
    }

    static #onOpenDecks() {
        openDeckEditor();
    }

    static #onOpenCosts() {
        openTypeCosts();
    }

    /**
     * Cards drag out to the canvas. Foundry's own TokenLayer._onDropActorData handles the drop,
     * which means compendium adversaries are imported into the world automatically and the
     * Daggerheart system's TokenDocument._preCreateOperation sizes the token from system.size.
     *
     * A stacked or minion card carries an extra quantity key that our dropCanvasData hook picks
     * up to place the whole group in one go.
     */
    get dragDrop() {
        return (this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
            dragSelector: '.rdbd-card[data-uuid]',
            dropSelector: null,
            permissions: { dragstart: () => game.user.isGM, drop: () => false },
            callbacks: { dragstart: this.#onDragStart.bind(this) }
        }));
    }

    /** @override */
    async _onRender(context, options) {
        await super._onRender(context, options);
        this.dragDrop.bind(this.element);
    }

    async #onDragStart(event) {
        const card = event.target.closest('.rdbd-card[data-uuid]');
        const uuid = card?.dataset.uuid;
        if (!uuid) return;

        const actor = await fromUuid(uuid).catch(() => null);
        if (!actor) return;

        const data = actor.toDragData();
        const count = Number(card.dataset.tokenCount) || 1;
        if (count > 1) data[DRAG_QUANTITY_KEY] = count;
        // Lets the drop handler grey this exact card out once the tokens are placed.
        data[DRAG_CARD_KEY] = card.dataset.key;

        event.dataTransfer.setData('text/plain', JSON.stringify(data));
    }
}

/** Open (or focus) the single Battle Encounters window. */
export function openEncounterBuilder() {
    const existing = foundry.applications.instances.get(APP_IDS.BUILDER);
    if (existing) return existing.render(true, { focus: true });
    return new EncounterBuilder().render(true);
}
