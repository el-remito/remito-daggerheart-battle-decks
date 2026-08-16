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

/**
 * Loose subsequence match, the sort of thing a search box is expected to do: "bnd" finds "Bandits"
 * and "gob c" finds "Goblin Camp". Whitespace in the query is dropped so a typed space never stops
 * a match, while the deck name keeps its own spaces so word boundaries still count.
 *
 * @param {string} query Lower-cased search text.
 * @param {string} text  Lower-cased deck name.
 * @returns {boolean}
 */
function fuzzyMatch(query, text) {
    const needle = query.replace(/\s+/g, '');
    if (!needle) return true;

    let i = 0;
    for (const character of text) {
        if (character === needle[i]) i += 1;
        if (i === needle.length) return true;
    }
    return false;
}

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
            addDeck: EncounterBuilder.#onAddDeck,
            removeDeck: EncounterBuilder.#onRemoveDeck,
            toggleSetup: EncounterBuilder.#onToggleSetup,
            openDecks: EncounterBuilder.#onOpenDecks,
            openCosts: EncounterBuilder.#onOpenCosts
        }
    };

    static PARTS = { main: { template: TEMPLATES.BUILDER } };

    /** @type {foundry.applications.ux.DragDrop|null} */
    #dragDrop = null;

    /**
     * Deck search text. Deliberately transient view state rather than part of the encounter: it
     * says nothing about the fight, and a filter left over from last session would be baffling.
     * Held on the instance so it survives the re-render that adding a deck triggers.
     * @type {string}
     */
    #deckFilter = '';

    /** Whether the search box had focus when the last render started, so it can be given back. */
    #deckFocused = false;

    /**
     * Whether the Decks / Modifiers / Battle Points block is folded away.
     *
     * Instance state for the same reason as {@link #deckFilter}: it is a statement about how this
     * window is being looked at, not about the fight, and a window that opened folded shut would
     * hide the controls from a GM who had forgotten why. Generate sets it (see AUTO_COLLAPSE); the
     * arrow in the setup bar overrides it either way, and keeps whatever the GM chose until the
     * next Generate.
     *
     * Note that the party fields and the Generate button deliberately sit outside it — the two
     * things worth reaching for while staring at a roster.
     * @type {boolean}
     */
    #setupCollapsed = false;

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
        const state = foundry.utils.mergeObject(blankState(), stored ?? {}, { inplace: false });

        // A deck deleted while it was being drawn from leaves its id behind here. Drop it on read,
        // not on write: every consumer — the chip list, the deckless check, Generate — then agrees
        // on what is selected, and the next #update persists the pruned list on its own. The old
        // multi-select got this for free, because it only ever submitted decks it had rendered.
        const decks = Decks.getDecks();
        state.deckIds = (state.deckIds ?? []).filter(id => decks.some(deck => deck.id === id));
        return state;
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
     * Each row carries two names. `short` is what renders — three words at most, because the panel
     * is one narrow column and the sheet's own phrasings ("No Bruisers, Hordes, Leaders or Solos?")
     * simply do not fit. `label` is the full wording, hung off the row as a tooltip so the
     * spreadsheet's exact question is still reachable.
     *
     * @param {object} state  Encounter state.
     * @param {object} budget Output of computeBudget().
     * @returns {object[]} { label, short, detail, value, derived } rows.
     */
    #modifierRows(state, budget) {
        const rows = [];
        const label = key => game.i18n.localize(`${NS}.Modifier.${key}.label`);
        // Falls back to the full label if a translation has not supplied a short form yet — a
        // clipped row beats a missing one.
        const short = key => {
            const shortKey = `${NS}.Modifier.${key}.short`;
            return game.i18n.has?.(shortKey) ? game.i18n.localize(shortKey) : label(key);
        };
        const row = (key, detail, value, derived) => ({
            label: label(key),
            short: short(key),
            detail,
            value,
            derived
        });

        for (const modifier of SELECT_MODIFIERS) {
            const value = budget.gm[modifier.key];
            if (!value) continue;
            const chosen = game.i18n.localize(
                `${NS}.Modifier.${modifier.key}.${state.modifiers[modifier.key]}`
            );
            rows.push(row(modifier.key, chosen, value, false));
        }

        if (budget.gm.extraDamage) {
            rows.push(
                row('extraDamage', `+${state.modifiers.extraDamageDice}d4`, budget.gm.extraDamage, false)
            );
        }

        if (budget.gm.adHoc) rows.push(row('adHoc', '', budget.gm.adHoc, false));

        rows.push(
            row(
                'manySolos',
                `${game.i18n.localize(`${NS}.Summary.totalSolos`)}: ${budget.derived.soloCount}`,
                budget.derived.manySolos,
                true
            )
        );
        rows.push(
            row(
                'noToughies',
                `${game.i18n.localize(`${NS}.Summary.validCounts`)}: ${budget.derived.toughieCount}`,
                budget.derived.noToughies,
                true
            )
        );

        return rows;
    }

    /** @override */
    async _prepareContext() {
        const state = this.state;
        const budget = budgetFor(state);
        const decks = Decks.getDecks();
        const spawned = state.spawned ?? [];

        // Counts of adversaries that still resolve, not of stored UUIDs. A deck holding a deleted
        // actor keeps its UUID on purpose, so the raw length overstates what the deck can draw.
        const counts = await Decks.resolvedCounts();

        const deckRows = decks.map(deck => ({
            id: deck.id,
            name: deck.name,
            count: counts.get(deck.id) ?? 0,
            selected: state.deckIds.includes(deck.id),
            // Pre-lowered here so the keystroke handler in #filterDeckOptions does no work per row
            // beyond the comparison itself. Tags and the deck's folder path are folded in: a tag
            // nobody can search for is just decoration.
            search: Decks.deckSearchText(deck)
        }));

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
            setupCollapsed: this.#setupCollapsed,

            decks: deckRows,
            hasDecks: decks.length > 0,
            // The droplist offers only what is not already in play, so adding a deck twice is not
            // a state the UI can reach.
            availableDecks: deckRows.filter(deck => !deck.selected),
            // Selection order, not catalogue order: the GM built this list, so it reads back the
            // way they built it.
            chosenDecks: state.deckIds
                .map(id => deckRows.find(deck => deck.id === id))
                .filter(Boolean),
            hasChosen: deckRows.some(deck => deck.selected),

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

        // Deck selection is not a form field any more — it is add/remove actions against
        // state.deckIds, so there is nothing to read for it here.

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

        // Generating is the moment the GM stops configuring and starts reading, so the setup folds
        // away and the roster takes the room. Re-roll comes through here too, which is right: it is
        // the same "show me the result" intent. Draw Another does not — it is an adjustment to an
        // encounter already on the table, and folding the panel out from under that would be rude.
        if (game.settings.get(MODULE_ID, SETTINGS.AUTO_COLLAPSE)) this.#setupCollapsed = true;

        // A fresh roster has never been placed, so nothing is greyed out.
        await this.#update({ cards, generated: true, spawned: [] });
    }

    static #onToggleSetup() {
        this.#setupCollapsed = !this.#setupCollapsed;
        this.render(false);
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

    /**
     * Add a deck to the draw pool from the search droplist.
     *
     * Appends rather than inserting in catalogue order, so the chosen list reads back in the order
     * the GM assembled it.
     */
    static async #onAddDeck(event, target) {
        const state = this.state;
        if (state.locked) return;

        const deckId = target.dataset.deckId;
        if (!deckId || state.deckIds.includes(deckId)) return;
        await this.#update({ deckIds: [...state.deckIds, deckId] });
    }

    /** Drop a deck out of the draw pool. Removing the last one is deckless mode, not an error. */
    static async #onRemoveDeck(event, target) {
        const state = this.state;
        if (state.locked) return;
        await this.#update({ deckIds: state.deckIds.filter(id => id !== target.dataset.deckId) });
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
        // Both re-bound every render: PARTS are replaced wholesale, listeners and all.
        this.dragDrop.bind(this.element);
        this.#bindDeckSearch();
    }

    /**
     * Wire the deck search box.
     *
     * Filtering happens entirely in the DOM. Routing it through state would mean a settings write
     * and a full re-render per keystroke, for something that is not part of the encounter at all.
     */
    #bindDeckSearch() {
        const search = this.element.querySelector('.rdbd-deck-search');
        if (!search) return;

        const input = search.querySelector('.rdbd-deck-filter');
        const options = search.querySelector('.rdbd-deck-options');
        if (!input || !options) return;

        // Adding a deck re-renders, which throws this DOM away; restore what the GM had typed.
        input.value = this.#deckFilter;
        this.#filterDeckOptions();

        input.addEventListener('input', () => {
            this.#deckFilter = input.value;
            this.#filterDeckOptions();
        });
        input.addEventListener('focus', () => {
            this.#deckFocused = true;
        });
        input.addEventListener('blur', () => {
            this.#deckFocused = false;
        });

        // The droplist is open only while the search box has focus. Clicking an option would
        // ordinarily move focus to that button, closing the list on mousedown — before the click
        // lands. Suppressing the default keeps focus in the input, so the button is still there to
        // be clicked and the list stays open for the next pick.
        options.addEventListener('pointerdown', event => event.preventDefault());

        if (this.#deckFocused) input.focus();
    }

    /** Show only the deck options matching the current search text. */
    #filterDeckOptions() {
        const options = this.element?.querySelector('.rdbd-deck-options');
        if (!options) return;

        const query = this.#deckFilter.trim().toLowerCase();
        const items = options.querySelectorAll('li[data-search]');
        let matches = 0;

        for (const item of items) {
            const hit = fuzzyMatch(query, item.dataset.search);
            item.hidden = !hit;
            if (hit) matches += 1;
        }

        // Only meaningful while something is being typed against a non-empty droplist. With every
        // deck already in play the template's own note is the right message, and saying "no deck
        // matches" underneath it would just be a second way of stating the same thing.
        const noMatch = options.querySelector('.rdbd-deck-no-match');
        if (noMatch) noMatch.hidden = matches > 0 || !query || !items.length;
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
