/**
 * Deck Editor — create decks and fill them by dragging adversaries in.
 *
 * GM-only. Accepts drops from the Actors sidebar, from a compendium, and from the system's own
 * Compendium Browser, all of which emit the standard { type: "Actor", uuid } drag payload.
 */

import { NS, TEMPLATES, APP_IDS } from '../config/constants.mjs';
import { typeLabel, isPriced, isIgnored } from '../config/adversary-types.mjs';
import * as Decks from '../data/decks.mjs';
import { baseCost } from '../helpers/bp.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DeckEditor extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: APP_IDS.DECK_EDITOR,
        // `daggerheart dh-style` pulls in the system's fonts, buttons and inputs so the window
        // reads as part of the system rather than a bolt-on. `rdbd-app` is our re-render hook.
        classes: ['daggerheart', 'dh-style', 'rdbd-app', 'rdbd-deck-editor'],
        tag: 'div',
        window: {
            frame: true,
            positioned: true,
            title: `${NS}.DeckEditor.title`,
            icon: 'fa-solid fa-cards-blank',
            minimizable: true,
            resizable: true
        },
        position: { width: 720, height: 620 },
        actions: {
            createDeck: DeckEditor.#onCreateDeck,
            selectDeck: DeckEditor.#onSelectDeck,
            renameDeck: DeckEditor.#onRenameDeck,
            deleteDeck: DeckEditor.#onDeleteDeck,
            removeAdversary: DeckEditor.#onRemoveAdversary,
            openAdversary: DeckEditor.#onOpenAdversary
        }
    };

    static PARTS = { main: { template: TEMPLATES.DECK_EDITOR } };

    /** @type {string|null} Currently selected deck id. */
    #selectedId = null;

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

    /** @override */
    async _prepareContext() {
        const decks = Decks.getDecks();

        // Keep the selection valid across deletes and re-renders.
        if (!decks.some(deck => deck.id === this.#selectedId)) {
            this.#selectedId = decks[0]?.id ?? null;
        }

        const adversaries = this.#selectedId ? await Decks.resolveDeck(this.#selectedId) : [];

        return {
            decks: decks.map(deck => ({
                ...deck,
                count: deck.uuids.length,
                selected: deck.id === this.#selectedId
            })),
            selectedId: this.#selectedId,
            selectedDeck: decks.find(deck => deck.id === this.#selectedId) ?? null,
            adversaries: adversaries.map(adversary => {
                // A deck is allowed to hold an adversary of an ignored type — that is the point of
                // the flag — but the row has to say so, or the GM is left wondering why this one
                // never turns up in a roster.
                const ignored = isIgnored(adversary.type);
                return {
                    ...adversary,
                    typeLabel: typeLabel(adversary.type),
                    ignored,
                    // A homebrew type with no cost configured yet; the row says so rather than
                    // showing a confident "0 BP". Moot for a type that can never be drawn.
                    unpriced: !isPriced(adversary.type) && !ignored,
                    baseCost: baseCost(adversary.type)
                };
            })
        };
    }

    /**
     * ApplicationV2 has no built-in dragDrop option — only the Actor/Item sheet subclasses read
     * one — so the handler is wired by hand, as in daggerheart-vessel-sheet's Engagement window.
     * @type {foundry.applications.ux.DragDrop}
     */
    get dragDrop() {
        return (this.#dragDrop ??= new foundry.applications.ux.DragDrop.implementation({
            dragSelector: null,
            dropSelector: null, // null binds the whole app element as a drop target
            permissions: { dragstart: () => false, drop: () => game.user.isGM },
            callbacks: { drop: this.#onDrop.bind(this) }
        }));
    }

    /** @override */
    async _onRender(context, options) {
        await super._onRender(context, options);
        // Re-bind every render: PARTS are replaced wholesale, taking the old listeners with them.
        this.dragDrop.bind(this.element);
    }

    /**
     * Accept an Actor drop into the selected deck.
     * @param {DragEvent} event
     */
    async #onDrop(event) {
        if (!this.#selectedId) {
            ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.noDeckSelected`));
            return;
        }

        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        if (data?.type !== 'Actor' || !data.uuid) return;

        // addToDeck does the adversary-type and duplicate checks and notifies on rejection.
        if (await Decks.addToDeck(this.#selectedId, data.uuid)) this.render(false);
    }

    static async #onCreateDeck() {
        const deck = await Decks.createDeck();
        if (deck) this.#selectedId = deck.id;
        this.render(false);
    }

    static #onSelectDeck(event, target) {
        this.#selectedId = target.dataset.deckId;
        this.render(false);
    }

    static async #onRenameDeck(event, target) {
        const deckId = target.dataset.deckId ?? this.#selectedId;
        const deck = Decks.getDeck(deckId);
        if (!deck) return;

        const name = await foundry.applications.api.DialogV2.prompt({
            window: { title: game.i18n.localize(`${NS}.DeckEditor.renameTitle`) },
            content: `<input type="text" name="name" value="${foundry.utils.escapeHTML(deck.name)}" autofocus>`,
            ok: {
                label: game.i18n.localize(`${NS}.Common.save`),
                callback: (event, button) => button.form.elements.name.value
            }
        }).catch(() => null);

        if (name) {
            await Decks.renameDeck(deckId, name);
            this.render(false);
        }
    }

    static async #onDeleteDeck(event, target) {
        const deckId = target.dataset.deckId ?? this.#selectedId;
        const deck = Decks.getDeck(deckId);
        if (!deck) return;

        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize(`${NS}.DeckEditor.deleteTitle`) },
            content: `<p>${game.i18n.format(`${NS}.DeckEditor.deleteConfirm`, { name: deck.name })}</p>`
        }).catch(() => false);

        if (confirmed) {
            await Decks.deleteDeck(deckId);
            this.render(false);
        }
    }

    static async #onRemoveAdversary(event, target) {
        await Decks.removeFromDeck(this.#selectedId, target.dataset.uuid);
        this.render(false);
    }

    static async #onOpenAdversary(event, target) {
        const actor = await fromUuid(target.dataset.uuid).catch(() => null);
        actor?.sheet?.render(true);
    }
}

/** Open (or focus) the single Deck Editor instance. */
export function openDeckEditor() {
    const existing = foundry.applications.instances.get(APP_IDS.DECK_EDITOR);
    if (existing) return existing.render(true, { focus: true });
    return new DeckEditor().render(true);
}

/** Re-render the editor when a deck's underlying actor changes name/type/tier. */
export function registerDeckEditorHooks() {
    const refresh = () => {
        Decks.invalidateCache();
        foundry.applications.instances.get(APP_IDS.DECK_EDITOR)?.render(false);
    };
    Hooks.on('updateActor', refresh);
    Hooks.on('deleteActor', refresh);
}
