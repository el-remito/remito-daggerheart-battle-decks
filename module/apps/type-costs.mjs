/**
 * Adversary BP Costs — the Settings-tab answer to "what does a custom adversary type cost?"
 *
 * The system stores a homebrew adversary type as { id, label, description } with no price, so
 * without this window a custom type would cost nothing and quietly break every budget it appeared
 * in. Here the GM gives each one a Battle Point cost, and can retune the ten built-in costs too.
 *
 * It is also where a type is switched off: an ignored type stays in whatever decks contain it but
 * is never drawn into an encounter, which is how a GM keeps, say, Socials out of a fight without
 * curating a second deck.
 *
 * Only differences from the system's own values are saved. That keeps the setting small and means
 * a future system revision to a built-in cost still reaches an untouched row.
 */

import { MODULE_ID, NS, SETTINGS, TEMPLATES, APP_IDS } from '../config/constants.mjs';
import { coreTypes, systemTypes, effectiveTypes } from '../config/adversary-types.mjs';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class TypeCostEditor extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
        id: APP_IDS.TYPE_COSTS,
        classes: ['daggerheart', 'dh-style', 'rdbd-app', 'rdbd-type-costs-app'],
        tag: 'form',
        window: {
            frame: true,
            positioned: true,
            title: `${NS}.TypeCosts.title`,
            icon: 'fa-solid fa-coins',
            minimizable: true,
            resizable: true
        },
        position: { width: 720, height: 640 },
        // Unlike the builder this form does NOT submit on change: costs re-price every existing
        // encounter, so the GM gets an explicit Save.
        form: { handler: TypeCostEditor.#onSubmit, submitOnChange: false, closeOnSubmit: true },
        actions: { resetAll: TypeCostEditor.#onResetAll }
    };

    static PARTS = { main: { template: TEMPLATES.TYPE_COSTS } };

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
        const core = coreTypes();
        const system = systemTypes();

        // The ten official types a homebrew type may declare itself equivalent to.
        const officialTypes = Object.values(core)
            .map(type => ({ value: type.id, label: game.i18n.localize(type.label ?? type.id) }))
            .sort((a, b) => a.label.localeCompare(b.label));

        const rows = Object.values(effectiveTypes())
            .map(type => ({
                id: type.id,
                label: game.i18n.localize(type.label ?? type.id),
                homebrew: type.homebrew,
                overridden: type.overridden,
                // An ignored type is never drawn, so having no cost is not a defect worth flagging
                // — switching a type off is a legitimate way to answer "this one has no price".
                unpriced: !type.priced && !type.ignored,
                // Blank rather than 0 for an unpriced type, so the placeholder can prompt for one.
                // An alias never fills this in: it says how the type behaves, not what it costs.
                cost: type.priced ? type.bpCost : '',
                grouped: type.partyAmountPerBP,
                ignored: type.ignored,
                alias: type.alias ?? '',
                aliasOptions: type.homebrew
                    ? officialTypes.map(option => ({ ...option, selected: option.value === type.alias }))
                    : null,
                systemCost: Number.isFinite(system[type.id]?.bpCost) ? system[type.id].bpCost : null
            }))
            // Anything still unpriced floats to the top: it is the only thing here that is broken.
            .sort((a, b) => Number(b.unpriced) - Number(a.unpriced) || a.label.localeCompare(b.label));

        return {
            rows,
            unpriced: rows.filter(row => row.unpriced),
            hasUnpriced: rows.some(row => row.unpriced),
            hasIgnored: rows.some(row => row.ignored),
            hasOverrides: rows.some(row => row.overridden),
            coreCount: Object.keys(core).length
        };
    }

    /**
     * Save the table, storing only what differs from the system's own values.
     *
     * @param {SubmitEvent}       event
     * @param {HTMLFormElement}   form
     * @param {FormDataExtended}  formData
     */
    static async #onSubmit(event, form, formData) {
        // FormDataExtended#object is flat in v14 — dotted names stay literal keys.
        const data = formData.object;
        const core = coreTypes();
        const system = systemTypes();
        const overrides = [];

        for (const id of Object.keys(effectiveTypes())) {
            const raw = data[`cost.${id}`];
            const cost = raw === null || raw === '' ? null : Number(raw);
            const grouped = data[`grouped.${id}`] === true;
            const ignored = data[`ignored.${id}`] === true;

            // Only homebrew rows render an alias select, so this is absent for the official ten.
            const chosenAlias = data[`alias.${id}`];
            const alias = chosenAlias && core[chosenAlias] ? chosenAlias : null;
            const aliased = alias ? core[alias] : null;

            // Costs compare against the system alone: an alias contributes nothing to price, so a
            // homebrew cost is always stored as entered. Grouping is different — it compares
            // against the alias where there is one, so that picking "treated as a Minion" does not
            // write out an explicit grouping override and pin a value the alias should keep
            // supplying.
            const inheritedCost = Number.isFinite(system[id]?.bpCost) ? system[id].bpCost : null;
            const inheritedGrouped = aliased
                ? aliased.partyAmountPerBP === true
                : system[id]?.partyAmountPerBP === true;

            // A blank cost is not "0" — it clears the override, which for a homebrew type means
            // going back to being unpriced whether or not it has an alias.
            const costDiffers = Number.isFinite(cost) && cost !== inheritedCost;
            const groupedDiffers = grouped !== inheritedGrouped;
            // Ignoring has no system counterpart to inherit from — off is the only default there
            // could be, so the flag is stored whenever it is on and dropped whenever it is off.
            if (!costDiffers && !groupedDiffers && !alias && !ignored) continue;

            const row = { id };
            if (costDiffers) row.bpCost = cost;
            if (groupedDiffers) row.partyAmountPerBP = grouped;
            if (alias) row.alias = alias;
            if (ignored) row.ignored = true;
            overrides.push(row);
        }

        await game.settings.set(MODULE_ID, SETTINGS.TYPE_COSTS, overrides);
        ui.notifications?.info(
            game.i18n.format(`${NS}.Notification.costsSaved`, { count: overrides.length })
        );
    }

    static async #onResetAll() {
        const confirmed = await foundry.applications.api.DialogV2.confirm({
            window: { title: game.i18n.localize(`${NS}.TypeCosts.resetTitle`) },
            content: `<p>${game.i18n.localize(`${NS}.TypeCosts.resetConfirm`)}</p>`
        }).catch(() => false);

        if (!confirmed) return;
        await game.settings.set(MODULE_ID, SETTINGS.TYPE_COSTS, []);
        this.render(false);
    }
}

/** Open (or focus) the single cost editor instance. */
export function openTypeCosts() {
    const existing = foundry.applications.instances.get(APP_IDS.TYPE_COSTS);
    if (existing) return existing.render(true, { focus: true });
    return new TypeCostEditor().render(true);
}
