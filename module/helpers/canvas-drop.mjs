/**
 * Multi-token canvas drops.
 *
 * A single card can stand for several creatures — a stacked draw, or a minion group where one BP
 * buys party-size minions. Core's TokenLayer._onDropActorData places exactly one token per drop,
 * so cards carrying a quantity are intercepted here and placed as a cluster instead.
 *
 * Single-token drops are deliberately left to core, which already imports compendium actors into
 * the world and lets the Daggerheart system size the token from `system.size`.
 *
 * Either way, the card that was dragged is marked as spawned so the builder can grey it out.
 */

import { DRAG_QUANTITY_KEY, DRAG_CARD_KEY, APP_IDS, NS } from '../config/constants.mjs';

/** Hard ceiling on one drop, so a bad quantity cannot carpet the scene. */
const MAX_TOKENS_PER_DROP = 40;

/**
 * Lay out N positions around the drop point: the first on the cursor, the rest in widening rings.
 * Positions are the token's *centre*; they are converted to top-left below.
 *
 * @param {number} count     How many tokens.
 * @param {number} x         Drop x, canvas coordinates.
 * @param {number} y         Drop y, canvas coordinates.
 * @param {number} spacing   Distance between neighbours, in pixels.
 * @returns {{x: number, y: number}[]}
 */
function cluster(count, x, y, spacing) {
    const points = [{ x, y }];
    let ring = 1;
    while (points.length < count) {
        const perRing = ring * 6; // hex-ish packing; plenty even for large groups
        for (let i = 0; i < perRing && points.length < count; i++) {
            const angle = (Math.PI * 2 * i) / perRing;
            points.push({
                x: x + Math.cos(angle) * spacing * ring,
                y: y + Math.sin(angle) * spacing * ring
            });
        }
        ring += 1;
    }
    return points;
}

/**
 * Tell the builder that a card reached the canvas, so it can be greyed out.
 *
 * Looked up through the instance registry rather than imported, which keeps this file free of any
 * dependency on the app layer. A closed builder simply has nothing to mark.
 *
 * @param {string} [key] Card key from the drag data.
 */
function markSpawned(key) {
    if (!key) return;
    foundry.applications.instances.get(APP_IDS.BUILDER)?.markSpawned(key);
}

/**
 * Place `count` tokens for one actor around a drop point.
 *
 * @param {object} data Drag data, already carrying x/y in canvas coordinates.
 */
async function placeTokenCluster(data) {
    if (!game.user.can('TOKEN_CREATE')) {
        ui.notifications?.warn(game.i18n.localize(`${NS}.Notification.noTokenPermission`));
        return;
    }

    let actor = await Actor.implementation.fromDropData(data).catch(() => null);
    if (!actor) return;

    // Mirror core: a compendium actor must exist in the world before it can back a token.
    if (actor.inCompendium) {
        const actorData = game.actors.fromCompendium(actor);
        actor = await Actor.implementation.create(actorData, { fromCompendium: true });
    }
    if (!actor?.isOwner) {
        ui.notifications?.warn(
            game.i18n.format(`${NS}.Notification.noActorPermission`, { name: actor?.name ?? '' })
        );
        return;
    }

    const count = Math.min(Number(data[DRAG_QUANTITY_KEY]) || 1, MAX_TOKENS_PER_DROP);

    // Build one token up front so the system's size logic has run before we measure spacing;
    // Daggerheart sets width/height from actor.system.size in TokenDocument._preCreateOperation.
    const prototype = await actor.getTokenDocument({}, { parent: canvas.scene });
    const spacing = Math.max(prototype.width, 1) * canvas.dimensions.size;

    const creations = [];
    let sort = Math.max(canvas.tokens.getMaxSort() + 1, 0);

    for (const point of cluster(count, data.x, data.y, spacing)) {
        const token = await actor.getTokenDocument({ sort: sort++ }, { parent: canvas.scene });
        // Same positioning core uses, so snapping, elevation and level all behave identically.
        token.updateSource(
            CONFIG.Token.objectClass._getDropActorPosition(
                token,
                { x: point.x, y: point.y, elevation: data.elevation },
                { snap: true }
            )
        );
        creations.push(token.toObject());
    }

    canvas.tokens.activate();
    await canvas.scene.createEmbeddedDocuments('Token', creations);

    // Only after the tokens actually exist — an early return above means nothing was placed, and
    // the card should stay live.
    markSpawned(data[DRAG_CARD_KEY]);
}

export function registerCanvasDrop() {
    Hooks.on('dropCanvasData', (canvasRef, data) => {
        if (data?.type !== 'Actor') return;

        const key = data[DRAG_CARD_KEY];
        if (Number(data[DRAG_QUANTITY_KEY]) > 1) {
            placeTokenCluster(data); // marks the card itself, once the tokens are created
            return false; // suppress core's single-token drop
        }

        // A single token is left to core, so we inherit its compendium import and the system's
        // token sizing for free. Nothing to await, so the card is marked on the same permission
        // check core is about to make — if the user cannot create tokens, nothing is spawned and
        // nothing should be greyed out.
        if (key && game.user.can('TOKEN_CREATE')) markSpawned(key);
    });
}
