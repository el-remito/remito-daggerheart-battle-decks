# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

`remito-daggerheart-battle-decks` — a Foundry VTT **v14** module for the Daggerheart
(Foundryborne) system **2.7+**. The GM builds named decks of adversary actors and rolls random
battle encounters from them, sized by the Valiran Battle Points homebrew. GM-only throughout.

## Source of truth

Two reference files live in the repo root and outrank anything in the code. **Both are
gitignored** — they are working references, not module content, so a fresh clone will not have
them and you may have to ask the author for a copy:

- **`Daggerheart Valiran Combat Encounter Calculator.xlsx`** — the rules. Hidden sheet `Reference`
  holds every lookup table; sheet `Main_v2` holds the live formulas and a worked example. Sheet
  `Main` is the superseded v1 and is hidden for that reason — though it is right about `M10` where
  v2 is wrong, so do not dismiss it. To read it without Excel:
  `unzip -p "…xlsx" xl/worksheets/sheet2.xml` (Main_v2), `sheet3.xml` (Reference), and
  `xl/sharedStrings.xml` to decode the `t="s"` string indices.
- **`Remito Daggerheat Battle Decks.md`** — the design brief. Two of its premises were wrong and
  were corrected during implementation; see "Known divergences" below.

The `.csv` alongside them is a values-only export of `Main_v2` with no formulas. It is not useful
on its own — use the `.xlsx`. It is gitignored too.

## Commands

**There is no build step, no bundler, no test runner and no linter.** Plain ES modules loaded
directly by Foundry, plain CSS.

To run it, symlink or copy the repo into the Foundry data directory:

```
C:\Users\<user>\AppData\Local\FoundryVTT\Data\modules\remito-daggerheart-battle-decks
```

then reload the world (F5).

To check the rules maths without launching Foundry, stub `CONFIG.DH` and import
`module/helpers/bp.mjs` in Node — `baseCost()` needs
`CONFIG.DH.ACTOR.allAdversaryTypes()` and `baseline()` needs
`CONFIG.DH.ENCOUNTER.BaseBPPerEncounter`. No `game` stub is required: `costOverrides()` catches
the missing global and falls back to the system's own costs, which is what keeps `bp.mjs` runnable
outside Foundry. Keep it that way. In the running app:

```js
game.modules.get("remito-daggerheart-battle-decks").api.selfTest()
```

which reproduces the `Main_v2` worked example and asserts every intermediate value.

## Architecture

```
battle-decks.mjs              entry point: init hooks, template partials, module API
module/config/constants.mjs   MODULE_ID, NS, SETTINGS, MENUS, TEMPLATES — bare exported consts
module/config/bp-tables.mjs   every BP lookup table, each annotated with its source cell
module/config/adversary-types.mjs  THE ONLY place a type's cost is resolved (system + overrides)
module/config/settings.mjs    world settings + the one settings-tab menu
module/data/decks.mjs         THE ONLY place that reads/writes the decks setting
module/helpers/bp.mjs         THE ONLY place that produces a BP number; pure functions
module/helpers/generator.mjs  draw / stack / draw-one / re-roll / put-back; card decoration
module/helpers/canvas-drop.mjs dropCanvasData hook for multi-token (minion group) drops
module/apps/encounter-builder.mjs  the main window
module/apps/deck-editor.mjs   deck CRUD + drag-in target
module/apps/type-costs.mjs    Adversary BP Costs editor, opened from Game Settings
module/ui/sidebar-button.mjs  Actors-tab button injection
module/ui/refresh.mjs         re-render every open module window
```

## Key invariants

**Never hardcode adversary base costs, and never read the system's type table directly.**
Everything goes through `config/adversary-types.mjs` → `effectiveTypes()`, which layers this
module's cost overrides on top of `CONFIG.DH.ACTOR.allAdversaryTypes()`. The system's ten built-in
values already match `Reference!T7:U16`, so an untouched type behaves exactly as the sheet expects.

The overrides exist because **the system cannot price a homebrew adversary type**: its Homebrew
setting stores one as `{ id, label, description }` with no `bpCost`, and its own
`AdversaryBPPerEncounter` falls back to `type.bpCost ?? 0`. A custom type would silently cost
nothing. So a type is either *priced* (a cost was resolved) or *unpriced*, and unpriced is
surfaced, never treated as free:

- `fillBudget()` skips anything whose unit cost is not `> 0`. A zero-cost entry never consumes
  budget, so it would stay affordable until `MAX_DRAW_ITERATIONS` and bury the roster.
- `generate()` and `drawOne()` warn, naming the offending types.
- `decorateCards()` sets `unpriced`, and the card shows a warning tag instead of "0 BP".

`isGrouped()` and the `partyAmountPerBP` flag resolve the same way.

**A homebrew type can be "treated as" an official one. That is a rules alias, and it carries no
price.** `effectiveTypes()` gives every type a `rulesType` — its alias where one is set, otherwise
its own id — and **anything in the rules that asks what kind of adversary this is must compare
`rulesType()`, never the raw `entry.type`**. `bp.countOfTypes()` is the one place that currently
matters: it is what makes a Warbeast treated as a Bruiser revoke the no-toughies bonus, and one
treated as a Solo count toward the two-Solos charge. Aliases are restricted to homebrew types
pointing at the system's own ten; a stale or invented alias resolves to nothing.

**An alias must never supply a BP cost.** Confirmed with the author 2026-08-16: being treated as a
Bruiser says how a type *behaves*, not what it is *worth*. An aliased type with no cost entered
stays `priced: false` — flagged on its cards, skipped when filling a budget — exactly as an
unaliased one would. `baseCost()` resolves from the override then the system, and stops. Do not
"helpfully" fall back to the alias.

The single exception is `partyAmountPerBP`, which an alias does carry, because "one BP buys a whole
group" is the substance of being a Minion rather than a claim about price. Because that value is
inherited, the save handler compares the grouping checkbox against the *alias-resolved* baseline
before storing anything — otherwise picking "treated as a Minion" would write out an explicit
grouping override, pinning a value the alias should keep supplying, and repointing the alias later
would leave the old behaviour behind. Costs, by contrast, compare against the system alone, so a
GM's entered number is always stored even when it happens to equal the aliased type's own cost.
`settings-harness.mjs` pins all of this.

**Party tier and size are not settings.** The Battle Encounters window owns both; the `encounter`
world setting is what remembers them between sessions, and `PARTY_DEFAULTS` in `bp-tables.mjs` is
a first-run seed only. There used to be two `config: true` settings duplicating them — do not add
them back, it gave two places to change one number.

**Modifiers add to the budget.** `Budget Left = Baseline - Adversaries + Modifiers`. So a
**positive** modifier hands the GM more BP to spend (a bigger fight is affordable) and a
**negative** one eats into the budget (the thing it describes is costing you). Getting this
backwards is the easiest mistake to make in this codebase — it is what went wrong in the source
spreadsheet, below.

**The toughie modifier deliberately departs from `Main_v2`.** This is the one place the code does
not follow the sheet. `Main_v2!M10` is `IF(<bruiser+horde+leader+solo count> = 0, 0, 1)` — `+1`
when a toughie **is** present — which, given the sign convention above, is a 1 BP *discount* for
fielding a big monster. It also contradicts the two rows beside it, where stronger adversaries
cost budget (`+Xd4 damage` is `-2` per die, `2+ Solos` is `-2`).

The hidden v1 sheet, the Daggerheart SRD, and the system's own
`CONFIG.DH.ENCOUNTER.BPModifiers[1].noToughies` all grant `+1` when **no** toughie is present. The
v2 rewrite flipped the condition while keeping the sign. Confirmed with the author 2026-08-16 that
the intent is for toughies to make an encounter cost *more*, so the v1/SRD form is what ships. See
`NO_TOUGHIES_BP` in `config/bp-tables.mjs`. **Do not "restore" the v2 formula.**

One extra guard beyond v1: an empty encounter scores `0`, not `+1`, matching the system's
`adversaries.length > 0` check. A blank roster earning a bonus for having no tough adversaries
reads as nonsense in the summary panel.

**The budget moves as the encounter grows.** Two modifiers are derived from the composition: the
first Bruiser/Horde/Leader/Solo revokes the `+1` no-toughies bonus, and a second Solo charges a
further `-2`. Both mean an adversary can cost more than its own price tag. Anything that decides
whether an adversary fits must re-evaluate the whole budget with the candidate included —
`generator.affords()` does this. Never cache a remaining-budget number across draws.

**Minion `quantity` counts groups, not creatures.** One BP buys a group of party-size minions
(`partyAmountPerBP`), which is why the sheet's row is labelled "Minion (Group)". `decorateCards()`
derives `displayCount = quantity x pcCount` for the badge and the canvas token count, while the
cost still uses `quantity`.

**UI code must not touch `game.settings` for decks.** Everything goes through
`module/data/decks.mjs`, which owns validation, GM gating and the hydration cache.

**Cross-window refresh goes through a setting's `onChange`, not through the caller.** The two
windows look at overlapping state — creating a deck in the editor changes the builder's deck
picker, re-pricing a type changes its BP readout — and ApplicationV2 does not react to settings on
its own. `decks` and `typeCosts` both call `ui/refresh.mjs` from `onChange`, which catches remote
GMs too. Do not sprinkle `render()` calls through the data layer instead; an app's own `render()`
is only for state the setting does not carry, like the Deck Editor's current selection.

**Modifier dropdowns show no numbers.** The option label is "High", not "High (+1)". Every
contributing modifier is listed with its value in the Battle Points panel instead
(`EncounterBuilder#modifierRows`), so the arithmetic is readable in one place rather than scattered
across four controls. The two composition-driven rows stay in that list even at 0, because their
counts are what explain the roster.

**Object-shaped settings are stored as arrays.** Both `decks` and `typeCosts` are
`ArrayField(ObjectField)` rather than keyed objects, because writing a setting merges plain objects
(`foundry.utils.mergeObject` recurses into them) but replaces arrays wholesale. An array is the
only shape a key can actually be *removed* from.

## Foundry v14 gotchas encountered here

- `ApplicationV2` has **no** `dragDrop` option — only the Actor/Item sheet subclasses read one.
  Wire `foundry.applications.ux.DragDrop.implementation` by hand and **re-bind in `_onRender`**,
  because PARTS are replaced wholesale on every render.
- `foundry.applications.instances` is the v14 registry for `ApplicationV2` (a `Map` keyed by app
  id, holding only *rendered* apps). `ui.windows` only tracks legacy `Application` instances.
- `FormDataExtended#object` is **flat** — it does not expand dotted names. `modifiers.difficulty`
  stays a literal key. Checkboxes without a `value` attribute yield real booleans.
- There is no `selected` Handlebars helper (only `checked` and `disabled`). Use
  `{{#if selected}}selected{{/if}}`.
- `loadTemplates()` given an object registers each template as a **named partial**, which is how
  the `.hbs` files reference `{{> rdbdAdversaryCard}}` and friends.
- `game.settings.registerMenu` accepts an `ApplicationV2` subclass in v14 (`client/helpers/
  client-settings.mjs:189` checks for `FormApplication` **or** `ApplicationV2`), so the cost editor
  does not need a v1 shim.
- `game.i18n.has(key)` is how the builder decides whether a modifier option has a long-form hint.
  Called optionally (`game.i18n.has?.()`) so the offline harnesses do not have to stub it.
- Core's `TokenLayer._onDropActorData` already imports compendium actors into the world on drop,
  and Daggerheart's `TokenDocument._preCreateOperation` sizes tokens from `system.size`. Only
  *place* tokens from `dropCanvasData` when there is more than one; let core handle singles. The
  hook still runs for singles so the card can be marked as spawned — a compendium card's UUID
  changes when core imports it, so matching a later `createToken` back to a card is not reliable;
  the drag data carries the card key instead (`DRAG_CARD_KEY`).
- `FormDataExtended` returns a `<select multiple>` as an **array**, and as an empty array when
  nothing is selected (`form-data-extended.mjs:205`). For the deck picker an empty array is a real
  value — deckless mode — so test with `Array.isArray()`, not truthiness; the field is absent
  entirely only when there are no decks to render.

## Known divergences from the design brief

1. The brief asks for the button in the **Journal** tab, "above the Compendium Browser button".
   That button is not in the Journal tab — Daggerheart's `ItemBrowser.injectSidebarButton` only
   injects for the `actors`, `items` and `compendium` tabs. The button therefore lives in the
   **Actors** tab, directly before the Compendium Browser button. Confirmed with the author.
2. The brief says all calculations derive from the `.csv`. The `.csv` has no formulas; the `.xlsx`
   does, and is what the implementation follows.
3. `Main_v2!M10` has a sign error and is not followed — see "Key invariants" above. Every other
   formula in the sheet is implemented verbatim.

## House style

Match the rest of the `remito-*` module family: heavily commented, prose-style JSDoc on every
file and non-obvious function, source-cell citations for anything rules-derived, all user-facing
strings in `lang/en.json` under the `RDBD.*` namespace, `rdbd-` prefixed CSS scoped to the module,
and `var(--dh-*, fallback)` for anything borrowed from the system's theme.
