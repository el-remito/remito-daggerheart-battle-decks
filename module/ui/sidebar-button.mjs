/**
 * "Battle Encounters" sidebar button.
 *
 * The design brief asked for this in the Journal tab, above the system's Compendium Browser
 * button. That button is not in the Journal tab: Daggerheart's ItemBrowser.injectSidebarButton
 * only injects for the `actors`, `items` and `compendium` tabs. The Actors tab is where it
 * actually lives — and where adversaries live — so that is where this button goes, immediately
 * before it. Markup deliberately mirrors the system's own so it inherits `.dh-style button`.
 */

import { NS } from '../config/constants.mjs';
import { openEncounterBuilder } from '../apps/encounter-builder.mjs';

const BUTTON_CLASS = 'rdbd-open-battle-encounters';

/**
 * @param {HTMLElement} html Rendered directory element.
 */
function injectButton(html) {
    if (!game.user.isGM) return;
    if (html.dataset.tab !== 'actors') return;

    // Directories re-render on every folder/actor change; without this guard the button stacks up.
    if (html.querySelector(`.${BUTTON_CLASS}`)) return;

    const actions = html.querySelector('.header-actions');
    if (!actions) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add(BUTTON_CLASS);
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-swords';
    icon.inert = true;
    button.append(icon, document.createTextNode(` ${game.i18n.localize(`${NS}.UI.battleEncounters`)}`));
    button.addEventListener('click', () => openEncounterBuilder());

    // Sit directly above the Compendium Browser button when the system has already injected it.
    // Hook order is not guaranteed, so fall back to appending if it is not there yet.
    const browser = actions.querySelector('.open-compendium-browser');
    if (browser) actions.insertBefore(button, browser);
    else actions.append(button);
}

export function registerSidebarButton() {
    Hooks.on('renderDocumentDirectory', (app, html) => {
        // Foundry hooks can hand back either an HTMLElement or a jQuery-wrapped one depending on
        // the application generation; normalise before touching the DOM.
        injectButton(html instanceof HTMLElement ? html : html[0]);
    });
}
