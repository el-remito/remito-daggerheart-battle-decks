/**
 * Deck Editor — create decks, organise them into folders, and fill them by dragging adversaries in.
 *
 * GM-only. Accepts drops from the Actors sidebar, from a compendium, and from the system's own
 * Compendium Browser, all of which emit the standard { type: "Actor", uuid } drag payload.
 *
 * THE RAIL IS A TREE, RENDERED FLAT
 * ---------------------------------
 * `Decks.deckTreeRows()` hands back folders and decks already interleaved in tree order, each with
 * an indentation depth. Every row is therefore a DOM sibling, which is what lets the reorder drop
 * be decided by one `getBoundingClientRect()` against whichever row the pointer happens to be over:
 * the top quarter means "above this", the bottom quarter "below this", and the middle of a folder
 * row means "inside this". Nested `<ul>`s would have needed a recursive partial and hit-testing
 * through the nesting for no gain.
 *
 * Both the reorder drags and the adversary drops arrive at the same `#onDrop`, told apart by the
 * `type` in their payload — ours is MOVE_DRAG_TYPE, everyone else's is `Actor`.
 */

import { NS, TEMPLATES, APP_IDS, MOVE_DRAG_TYPE } from '../config/constants.mjs';
import { typeLabel, isPriced, isIgnored } from '../config/adversary-types.mjs';
import * as Decks from '../data/decks.mjs';
import { refreshOpenWindows } from '../ui/refresh.mjs';
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
        position: { width: 820, height: 640 },
        actions: {
            createDeck: DeckEditor.#onCreateDeck,
            createFolder: DeckEditor.#onCreateFolder,
            selectDeck: DeckEditor.#onSelectDeck,
            toggleFolder: DeckEditor.#onToggleFolder,
            editEntry: DeckEditor.#onEditEntry,
            deleteEntry: DeckEditor.#onDeleteEntry,
            removeAdversary: DeckEditor.#onRemoveAdversary,
            openAdversary: DeckEditor.#onOpenAdversary
        }
    };

    static PARTS = { main: { template: TEMPLATES.DECK_EDITOR } };

    /** @type {string|null} Currently selected deck id. */
    #selectedId = null;

    /** @type {foundry.applications.ux.DragDrop|null} */
    #dragDrop = null;

    /**
     * What the GM is currently dragging out of the rail, or null for a drag that started elsewhere
     * (an actor from the sidebar). `dragover` cannot read `dataTransfer`, so the drop indicator has
     * no other way to know whether this is a reorder.
     * @type {{kind: 'deck'|'folder', id: string}|null}
     */
    #dragging = null;

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
        const selectedDeck = decks.find(deck => deck.id === this.#selectedId) ?? null;

        // Counts of what still resolves, not of stored UUIDs — a deleted actor leaves its UUID
        // behind on purpose, and the badge must not go on claiming it.
        const counts = await Decks.resolvedCounts();

        return {
            // Folders and decks already interleaved and indented; the template renders one flat
            // <ul> of these and never has to know the tree exists.
            rows: Decks.deckTreeRows().map(row => ({
                ...row,
                isFolder: row.kind === 'folder',
                count: row.kind === 'folder' ? row.deckCount : (counts.get(row.id) ?? 0),
                selected: row.kind === 'deck' && row.id === this.#selectedId,
                hasTags: row.tags.length > 0
            })),
            hasRows: decks.length > 0 || Decks.getFolders().length > 0,
            selectedId: this.#selectedId,
            selectedDeck,
            selectedPath: selectedDeck ? Decks.folderPath(selectedDeck.folderId) : '',
            selectedTags: selectedDeck?.tags ?? [],
            // UUIDs in this deck that no longer resolve. Left in the deck by design, but silence
            // about them is what made the old badge look broken rather than merely stale.
            missing: Math.max(0, (selectedDeck?.uuids?.length ?? 0) - adversaries.length),
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
            // Only the grip starts a drag. Making the whole row draggable would have fought the
            // click-to-select on the row's own button.
            dragSelector: '.rdbd-drag-handle',
            dropSelector: null, // null binds the whole app element as a drop target
            permissions: { dragstart: () => game.user.isGM, drop: () => game.user.isGM },
            callbacks: {
                dragstart: this.#onDragStart.bind(this),
                dragover: this.#onDragOver.bind(this),
                drop: this.#onDrop.bind(this)
            }
        }));
    }

    /** @override */
    async _onRender(context, options) {
        await super._onRender(context, options);
        // Re-bind every render: PARTS are replaced wholesale, taking the old listeners with them.
        this.dragDrop.bind(this.element);

        // dragend is the only event guaranteed to fire however a drag ends — dropped, cancelled
        // with Escape, or released over nothing — so it is what clears the indicator and the
        // in-flight record. DragDrop has no callback for it.
        for (const handle of this.element.querySelectorAll('.rdbd-drag-handle')) {
            handle.addEventListener('dragend', () => {
                this.#dragging = null;
                this.#clearDropMarks();
            });
        }
    }

    /* ---------------------------------------- */
    /*  Reorder drag                            */
    /* ---------------------------------------- */

    /** @param {DragEvent} event */
    #onDragStart(event) {
        const handle = event.currentTarget;
        const kind = handle.dataset.kind;
        const id = handle.dataset.id;
        if (!kind || !id) return;

        this.#dragging = { kind, id };
        event.dataTransfer.setData('text/plain', JSON.stringify({ type: MOVE_DRAG_TYPE, kind, id }));

        // Drag the whole row rather than the grip, which is a 12px icon and makes a useless ghost.
        const row = handle.closest('.rdbd-tree-row');
        if (row) event.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2);
    }

    /**
     * Work out what a drop at this pointer position would mean.
     *
     * Quarters, not halves, on a folder row: the outer eighths reorder the folder among its
     * siblings and the middle half drops into it. A deck row has no inside, so it splits in two.
     *
     * @param {DragEvent} event
     * @returns {{row: HTMLElement|null, kind: string|null, id: string|null,
     *            placement: 'before'|'after'|'into'|'root'}|null}
     *          Null when the pointer is not over the rail at all.
     */
    #dropTarget(event) {
        const rail = event.target?.closest?.('.rdbd-deck-list');
        if (!rail) return null;

        const row = event.target.closest('.rdbd-tree-row');
        if (!row) return { row: null, kind: null, id: null, placement: 'root' };

        const rect = row.getBoundingClientRect();
        const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
        const kind = row.dataset.kind;
        const placement =
            kind === 'folder'
                ? ratio < 0.25
                    ? 'before'
                    : ratio > 0.75
                      ? 'after'
                      : 'into'
                : ratio < 0.5
                  ? 'before'
                  : 'after';

        return { row, kind, id: row.dataset.id, placement };
    }

    /** Strip every drop indicator. Cheap enough to do on each dragover before re-marking. */
    #clearDropMarks() {
        for (const marked of this.element?.querySelectorAll(
            '.rdbd-drop-before, .rdbd-drop-after, .rdbd-drop-into, .rdbd-drop-root'
        ) ?? []) {
            marked.classList.remove('rdbd-drop-before', 'rdbd-drop-after', 'rdbd-drop-into', 'rdbd-drop-root');
        }
    }

    /** @param {DragEvent} event */
    #onDragOver(event) {
        this.#clearDropMarks();

        const target = this.#dropTarget(event);
        if (!target) return;

        // A drag that started outside the window is an adversary looking for a deck, so the only
        // meaningful target is a deck row — never a folder, and never the empty rail.
        if (!this.#dragging) {
            if (target.kind === 'deck') target.row.classList.add('rdbd-drop-into');
            return;
        }

        if (target.placement === 'root') {
            this.element.querySelector('.rdbd-decks')?.classList.add('rdbd-drop-root');
            return;
        }
        if (target.id === this.#dragging.id && target.kind === this.#dragging.kind) return;
        target.row.classList.add(`rdbd-drop-${target.placement}`);
    }

    /* ---------------------------------------- */
    /*  Drop                                    */
    /* ---------------------------------------- */

    /**
     * One handler, two kinds of payload: our own reorder drags and everyone else's `Actor` drops.
     * @param {DragEvent} event
     */
    async #onDrop(event) {
        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        const dragging = this.#dragging;

        this.#dragging = null;
        this.#clearDropMarks();

        if (data?.type === MOVE_DRAG_TYPE) return this.#onMoveDrop(event, data, dragging);
        if (data?.type !== 'Actor' || !data.uuid) return;

        // Dropping onto a deck row files the adversary there; anywhere else means the deck already
        // open on the right. Without the first rule, dragging an actor squarely onto a deck in the
        // rail would silently put it in a different deck.
        const row = event.target?.closest?.('.rdbd-tree-row[data-kind="deck"]');
        const deckId = row?.dataset.id ?? this.#selectedId;
        if (!deckId) {
            ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.noDeckSelected`));
            return;
        }

        // addToDeck does the adversary-type and duplicate checks and notifies on rejection.
        if (await Decks.addToDeck(deckId, data.uuid)) {
            this.#selectedId = deckId;
            this.render(false);
        }
    }

    /**
     * @param {DragEvent} event
     * @param {{kind: string, id: string}} data     The payload, authoritative over #dragging.
     * @param {{kind: string, id: string}|null} dragging
     */
    async #onMoveDrop(event, data, dragging) {
        const moved = data.id ? data : dragging;
        if (!moved?.id) return;

        const target = this.#dropTarget(event);
        if (!target) return;
        if (target.id === moved.id && target.kind === moved.kind) return;

        let destination;
        if (target.placement === 'root') destination = { parentId: null };
        else if (target.placement === 'into') destination = { parentId: target.id };
        else destination = { relativeTo: { kind: target.kind, id: target.id }, placement: target.placement };

        if (await Decks.moveEntry(moved.kind, moved.id, destination)) this.render(false);
    }

    /* ---------------------------------------- */
    /*  Actions                                 */
    /* ---------------------------------------- */

    static async #onCreateDeck(event, target) {
        const deck = await Decks.createDeck(undefined, target.dataset.folderId ?? null);
        if (deck) this.#selectedId = deck.id;
        this.render(false);
    }

    static async #onCreateFolder(event, target) {
        await Decks.createFolder(undefined, target.dataset.folderId ?? null);
        this.render(false);
    }

    static #onSelectDeck(event, target) {
        this.#selectedId = target.dataset.id;
        this.render(false);
    }

    static async #onToggleFolder(event, target) {
        await Decks.toggleFolder(target.dataset.id);
        this.render(false);
    }

    /**
     * One dialog edits both the name and the tags, for a folder or a deck alike.
     *
     * Tags are typed as a comma-separated list rather than given a chip editor: they are three or
     * four short words on a row that is already carrying a name and a count, and a bespoke input
     * would be more chrome than the feature is worth.
     */
    static async #onEditEntry(event, target) {
        const kind = target.dataset.kind;
        const id = target.dataset.id;
        const entry = kind === 'folder' ? Decks.getFolder(id) : Decks.getDeck(id);
        if (!entry) return;

        const escape = foundry.utils.escapeHTML;
        const title = game.i18n.localize(
            kind === 'folder' ? `${NS}.DeckEditor.editFolderTitle` : `${NS}.DeckEditor.editDeckTitle`
        );

        const result = await foundry.applications.api.DialogV2.prompt({
            window: { title },
            content: `
                <div class="rdbd-dialog">
                    <div class="rdbd-field">
                        <label for="rdbd-edit-name">${game.i18n.localize(`${NS}.DeckEditor.name`)}</label>
                        <input id="rdbd-edit-name" type="text" name="name" value="${escape(entry.name)}" autofocus>
                    </div>
                    <div class="rdbd-field">
                        <label for="rdbd-edit-tags">${game.i18n.localize(`${NS}.DeckEditor.tags`)}</label>
                        <input id="rdbd-edit-tags" type="text" name="tags" value="${escape(entry.tags.join(', '))}">
                        <p class="rdbd-field-hint">${game.i18n.localize(`${NS}.DeckEditor.tagsHint`)}</p>
                    </div>
                </div>`,
            ok: {
                label: game.i18n.localize(`${NS}.Common.save`),
                callback: (dialogEvent, button) => ({
                    name: button.form.elements.name.value,
                    tags: button.form.elements.tags.value
                })
            }
        }).catch(() => null);

        if (!result) return;
        if (kind === 'folder') await Decks.updateFolder(id, result);
        else await Decks.updateDeck(id, result);
        this.render(false);
    }

    static async #onDeleteEntry(event, target) {
        const kind = target.dataset.kind;
        const id = target.dataset.id;
        if (kind === 'folder') return DeckEditor.#deleteFolder.call(this, id);

        const deck = Decks.getDeck(id);
        if (!deck) return;

        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize(`${NS}.DeckEditor.deleteTitle`) },
            content: `<p>${game.i18n.format(`${NS}.DeckEditor.deleteConfirm`, { name: deck.name })}</p>`
        }).catch(() => false);

        if (confirmed) {
            await Decks.deleteDeck(id);
            this.render(false);
        }
    }

    /**
     * Deleting a folder asks which of two very different things the GM meant, because one of them
     * takes every deck inside it with it. Emptying the folder is the default and the safe answer;
     * the destructive button is labelled with what it actually destroys.
     *
     * @param {string} id Folder id.
     */
    static async #deleteFolder(id) {
        const folder = Decks.getFolder(id);
        if (!folder) return;

        const contents = Decks.deckTreeRows().find(row => row.kind === 'folder' && row.id === id);
        const count = contents?.deckCount ?? 0;

        const choice = await foundry.applications.api.DialogV2.wait({
            window: { title: game.i18n.localize(`${NS}.DeckEditor.deleteFolderTitle`) },
            content: `<p>${game.i18n.format(`${NS}.DeckEditor.deleteFolderConfirm`, {
                name: foundry.utils.escapeHTML(folder.name),
                count
            })}</p>`,
            buttons: [
                {
                    action: 'promote',
                    icon: 'fa-solid fa-folder-open',
                    label: game.i18n.localize(`${NS}.DeckEditor.deleteFolderOnly`),
                    default: true
                },
                {
                    action: 'cascade',
                    icon: 'fa-solid fa-trash',
                    label: game.i18n.format(`${NS}.DeckEditor.deleteFolderAll`, { count })
                },
                { action: 'cancel', icon: 'fa-solid fa-xmark', label: game.i18n.localize(`${NS}.Common.cancel`) }
            ]
        }).catch(() => 'cancel');

        if (choice === 'cancel' || !choice) return;
        await Decks.deleteFolder(id, { cascade: choice === 'cascade' });
        this.render(false);
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

/**
 * Re-render on any change to an adversary a deck points at.
 *
 * Both windows, not just the editor: deck counts are now counts of what still resolves, so
 * deleting an adversary changes a number in the builder's deck picker too. The hydration cache has
 * to be dropped first or every window would re-render against the same stale entry.
 */
export function registerDeckEditorHooks() {
    const refresh = () => {
        Decks.invalidateCache();
        refreshOpenWindows();
    };
    Hooks.on('updateActor', refresh);
    Hooks.on('deleteActor', refresh);
}
