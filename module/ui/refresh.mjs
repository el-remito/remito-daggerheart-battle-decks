/**
 * Re-render every open module window.
 *
 * ApplicationV2 windows do not react to settings changes on their own, and this module has two of
 * them looking at overlapping state: creating a deck in the Deck Editor changes the list the
 * Battle Encounters window draws from, and re-pricing an adversary type changes its BP readout.
 * Without this, a new deck only appeared after the builder was closed and reopened.
 *
 * Lives in its own file so both config/settings.mjs and data/decks.mjs can use it without the data
 * layer having to import app code.
 */

/** Marker class every window of this module carries; see each app's DEFAULT_OPTIONS.classes. */
const APP_CLASS = 'rdbd-app';

export function refreshOpenWindows() {
    // foundry.applications.instances is the v14 registry for ApplicationV2, and holds only
    // *rendered* apps. ui.windows tracks legacy Application instances and would miss ours entirely.
    for (const app of foundry.applications.instances.values()) {
        if (app.options?.classes?.includes(APP_CLASS)) app.render(false);
    }
}
