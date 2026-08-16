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
module/helpers/generator.mjs  draw / stack / draw-one / re-roll / put-back / frozen cards; card decoration
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

**An ignored type is filtered out in exactly one place: `generator.buildPool()`.** Every draw path
— Generate, *Draw Another*, per-card re-roll — goes through it, so filtering there is what makes
"ignored" airtight. Do not add a second filter at a call site; do not filter in `decorateCards()`
or anywhere that touches cards already on the table, because ignoring a type is a draw-pool rule,
not a retroactive edit of an encounter the GM has accepted. Ignore is also never inherited from an
alias (whether a type is worth rolling is a statement about this table, not about Bruisers), and an
ignored type is excluded from `unpricedTypes()` and from the editor's `unpriced` flag — it can
never reach a budget, so a missing cost is no longer a defect worth nagging about.

**Party tier and size are not settings.** The Battle Encounters window owns both; the `encounter`
world setting is what remembers them between sessions, and `PARTY_DEFAULTS` in `bp-tables.mjs` is
a first-run seed only. There used to be two `config: true` settings duplicating them — do not add
them back, it gave two places to change one number.

`autoCollapseSetup` is the *only* `config: true` setting, and is not a counterexample: it is a
**view preference with no other home**, not a duplicate of state the window already owns, and it is
`scope: 'client'` for that reason — two GMs at one table must not overwrite each other's. Anything
that describes the *encounter* belongs in the `encounter` blob; anything that describes *how one
person looks at it* belongs on the instance or, if it must persist, in a client setting.

**The setup fold is instance state, and the fold line is deliberate.** `#setupCollapsed` lives on
the app for the same reason as `#deckFilter` — it says nothing about the fight, and a window that
opened folded shut would hide the controls from a GM who had forgotten why. `.rdbd-control-grid`
(party tier, PCs, mode, target) and `.rdbd-actions` (Generate) sit **outside** the fold on purpose:
they are the two things worth reaching for while reading a roster. Only `#onGenerate` collapses —
`#onRerollAll` delegates to it and so inherits the behaviour, which is correct, but `#onDrawOne`
must not, because it adjusts an encounter already on the table. Collapsing hides the Battle Points
panel, so the setup bar carries the budget and deck count itself; if the fold ever grows to cover
more, that digest has to keep pace or the GM loses the number the whole window exists to produce.

Note that `.rdbd-columns` sets `display: grid`, which **beats the UA stylesheet's
`[hidden] { display: none }`** — hence the explicit `.rdbd-columns[hidden]` rule. Removing it makes
the fold silently do nothing. `.rdbd-card-grid` carries `flex: 1` and `align-content: start` so the
freed height actually goes to the roster instead of becoming a gap, without stretching three cards
to fill a tall window.

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

**The deck tree is two flat arrays, derived into a tree on read.** `decks` and `deckFolders` are
separate settings; a deck's place in the tree is one `folderId`, a folder's is one `parentId`. Do
not nest decks inside folder records — a move would become a splice through two levels, and one bad
folder record would take its decks with it. Instead, `normalize()` reparents anything whose folder
no longer exists to the root, `walk()` caps its recursion at `MAX_FOLDER_DEPTH` so a `parentId`
cycle cannot hang a render, and both `getFolders()` and `getDecks()` append whatever the walk could
not reach rather than dropping it. A 1.0.x world has none of these fields at all and is read as-is:
**there is no migration pass, and adding one would be a step backwards** — read-time normalisation
means there is no such thing as a half-migrated blob.

`sort` is a plain 0-based index within its own **(parent, kind)** sibling run, renumbered after
every structural change. Folders always sort above decks in the same parent, per Foundry's own
sidebar, which is why the two kinds keep separate runs and why an anchor of the wrong kind degrades
to alphabetical in `moveEntry()`. Alphabetical placement is what a *newly created* deck or folder
gets and nothing more — **renaming must never re-file anything**, or the order the GM arranged by
hand is destroyed by an edit they made for another reason.

**A deck count is a count of adversaries that still resolve — never `uuids.length`.** A deck keeps
the UUID of a deleted actor on purpose (`resolveAdversary` returns null and leaves it in place, so
re-enabling a compendium restores the deck), which makes the stored list a record of intent rather
than an inventory. Rendering the raw length is what made the editor's badge disagree with the pane
beside it and never come back down after a deletion. `resolvedCounts()` is the one place this is
computed; it resolves the union of every deck's UUIDs once and is served from the hydration cache
after the first call. `updateActor`/`deleteActor` must therefore invalidate that cache and refresh
**both** windows, not just the editor — the builder's picker shows the same numbers.

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

**Every modifier carries two names.** `RDBD.Modifier.<key>.label` is the spreadsheet's own wording;
`.short` is at most three words and is what the Battle Points panel renders, with the full label on
the tooltip. Adding a modifier means adding both — `#modifierRows` falls back to `.label` if
`.short` is missing, which keeps the row printable but clipped. The builder's own dropdowns still
use the full label: they get a whole column each.

**Deck selection is not a form field.** It lives in `state.deckIds` and changes only through the
`addDeck` / `removeDeck` actions, so nothing in `#onChangeForm` reads it. The search box's text is
instance state (`#deckFilter`), never persisted — it says nothing about the encounter — and
filtering runs against the DOM in `#filterDeckOptions` rather than through a re-render, because a
settings write per keystroke would be absurd. `#bindDeckSearch` restores both the text and the
focus after the re-render that adding a deck triggers, and suppresses `pointerdown` on the droplist
so clicking an option does not blur the input and close the list before the click lands.

**The Deck Editor's rail is a tree rendered flat.** `deckTreeRows()` returns folders and decks
already interleaved in tree order with an indentation `depth`, and the template renders one `<ul>`
of siblings indented by `--rdbd-depth`. That is what lets a drop be decided from a single
`getBoundingClientRect()` on whatever row the pointer is over — outer quarters of a folder row
reorder, the middle half files into it, a deck row splits in two. A nested `<ul>` would need a
recursive partial and hit-testing through the nesting for nothing. Only `.rdbd-drag-handle` is
draggable, because making the whole row draggable fights the click-to-select on its own button, and
`dragend` (bound by hand in `_onRender` — `DragDrop` has no callback for it) is what clears the
drop indicator, since it is the only event that fires however a drag ends.

Both reorder drags and adversary drops land in the same `#onDrop`, told apart by the `type` in
their payload (`MOVE_DRAG_TYPE` vs `Actor`). `dragover` cannot read `dataTransfer`, which is why
the in-flight drag is also held in `#dragging`.

**The three builder columns are all `<fieldset>`s.** Decks, Modifiers and the Battle Points summary
share border, padding and first-baseline purely by being the same element with a `<legend>`. If the
summary is ever turned back into a `<section>` with a heading, it will sit a few pixels off from its
neighbours again. Modifier rows are stacked (label above control, control at `width: 100%`) for the
same reason: in a ~250px column, side-by-side gave every dropdown a different width.

**Object-shaped settings are stored as arrays.** `decks`, `deckFolders` and `typeCosts` are all
`ArrayField(ObjectField)` rather than keyed objects, because writing a setting merges plain objects
(`foundry.utils.mergeObject` recurses into them) but replaces arrays wholesale. An array is the
only shape a key can actually be *removed* from.

**DialogV2 content is not inside `.rdbd-app`.** The module's palette is declared on `.rdbd-app,
.rdbd-dialog` for that reason, and any dialog markup this module builds must wrap itself in
`.rdbd-dialog` or every `--rdbd-*` in it resolves to nothing. `.rdbd-info-badge` is scoped to both
roots for the same reason — it appears in the deck editor's edit dialog.

**`effectiveTypes()` is memoized, and the generator depends on that for its speed.** `baseCost()`
reads the merged type table, and `fillBudget()`'s affordability check calls `baseCost()` once per
encounter line, per pool candidate, per draw iteration — O(iterations x pool x roster). Rebuilding
the table per call (which included a `game.settings.get`) measured **1.8 seconds** for one Generate
over a 240-adversary pool, against 46ms memoized: a 15-39x speedup across every configuration
tested. If a future change makes the table rebuild per call again, the module gets slow in exactly
the way that is hard to attribute, because nothing errors.

The table is frozen as well as cached, since it is now shared rather than rebuilt per caller. Every
caller today maps or filters into fresh objects; the freeze is what stops a future one from
assigning into the shared table and corrupting every cost until the next invalidation.

Two things invalidate it: this module's TYPE_COSTS `onChange`, and an `updateSetting` hook in
`battle-decks.mjs` that catches changes to the *system's* homebrew adversary types. Both are needed
— the second has no onChange of ours to hang off.

The draw is still O(iterations x pool x roster) and `affords()` still copies the roster per
candidate. That is deliberate: after memoization the worst configuration measured 46ms, which is
imperceptible, and unpicking it would mean maintaining the two composition-driven modifiers
incrementally — real risk to the BP maths for no felt gain. Re-measure before optimizing further.

**A frozen card is frozen against the pool, not just against the card list.** `state.lockedCards`
holds card keys. Carrying those cards through a redraw is the easy half; the half that is easy to
lose is that *every draw path must also remove their keys from the pool* — `generate`, `drawOne`
and `rerollCard` all do. Without it a fresh Generate can roll the same adversary, `stack()` finds
the existing card, and a card the GM froze at x2 silently becomes x3. "Nothing increases, decreases,
changes or removes it" was the requirement, and *increases* is the clause a card-list-only
implementation fails.

Frozen cards are seeded into `fillBudget`/`drawFree` as the starting card list rather than being
added afterwards, which is the whole of how they get costed: `affords()` prices the entire
prospective roster on every candidate, so a frozen Bruiser spends its 4 BP and feeds the two
composition-driven modifiers before the first card is drawn. In free draw, `drawCount` is a roster
size and frozen units count toward it, for consistency with that.

**Reset spares frozen cards. This is deliberate, and was the author's call.** It makes Reset mean
"clear everything I have not deliberately kept", which is what turns freezing into a way to build a
fight up across several generations. Do not "fix" it into a full wipe. The per-card padlock and
`state.locked` (the *Accept* button) are unrelated mechanisms that happen to share the word "lock".

**`lockedCards` is pruned on read**, in the `state` getter, alongside `deckIds` — a key whose card
has left the roster is dropped. Otherwise the same adversary drawn again later would arrive
mysteriously pre-frozen.

**Re-roll and put-back both move exactly one unit; freeze moves the whole stack.** The asymmetry is
intentional: freezing half of a x3 card would mean splitting it, and a partly-frozen card would need
a second number on it to say how much. Re-roll's `replace()` keeps the remainder of the stack at its
original index and splices the replacement in directly after, so re-rolling does not rearrange the
grid under the pointer.

**Field hints live in `data-tooltip` on an `.rdbd-info-badge`, not in a paragraph.**
`.rdbd-field-hint` was removed in v1.2.0: two lines of explanatory text per field cost more height
than the fields themselves. The badge is a `<span tabindex="0">` and not a `<button>` on purpose —
it does nothing when clicked, and announcing an action that does not exist is worse than the
tabindex it needs to stay keyboard-reachable.

**`deckDigest` is pre-escaped HTML and the template emits it with a triple-stache.** Foundry's
tooltip assigns `data-tooltip` through innerHTML, so a multi-line list needs real `<br>` elements;
the deck names around them are GM-typed free text and are passed through `foundry.utils.escapeHTML`
individually. Do not switch it to a double-stache (the `<br>`s become literal text) and do not drop
the escaping.

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
- **Core styles every `button` with a fixed height** (`height: var(--button-size); min-height:
  var(--button-size)` — 2rem). Any button of ours whose content can wrap to two lines must set
  `height: auto` and re-establish a `min-height`, or the content overflows the box and collides
  with whatever is beneath it. This is what clipped the deck rail's tag rows in v1.1.0; see
  `.rdbd-app .rdbd-deck-name`.
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
