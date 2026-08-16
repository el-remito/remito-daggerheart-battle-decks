# Remito's Battle Decks

A Foundry VTT module for the [Daggerheart (Foundryborne)](https://foundryvtt.com/packages/daggerheart)
system. Build named **decks** of adversaries, then roll random **battle encounters** from them,
sized by the Valiran Battle Points homebrew.

Foundry **v14**, Daggerheart system **2.7+**. GM-only.

## Features

- **Battle Encounters window**, opened from a button in the Actors sidebar tab.
- **Deck building** — drag adversaries in from the Actors sidebar, a compendium, or the system's
  Compendium Browser. Decks store UUIDs only, so world actors and compendium adversaries can sit
  side by side and edits to an adversary are picked up automatically.
- **Two generation modes** behind one button:
  - *Fill BP budget* — keeps drawing while the encounter stays within its Battle Points.
  - *Free draw* — pulls a fixed number of adversaries and reports the damage afterwards. A
    **Draw Another** button adds one more adversary without disturbing the encounter you already
    have, so you can build a fight up a card at a time.
- **Full Battle Points readout** — baseline, adversary spend, modifiers and budget left, and
  underneath, every modifier that is actually contributing something, with its value. The modifier
  dropdowns themselves stay clean ("High", not "High (+1)") because the arithmetic lives here.
- **Deckless mode** — with no deck selected, the encounter is generated as a list of adversary
  *categories* rather than actors, for when you want the shape of a fight without the roster.
- **Per-card re-roll and put-back**, plus **Accept / Re-roll / Reset** for the encounter as a whole.
- **Drag to canvas** — spawns tokens, importing compendium adversaries into the world
  automatically. A minion card places the whole group in one drag. A card that has been placed is
  greyed out and pinned, so a long fight is easy to work through; re-rolling or resetting clears
  the marks.
- **Custom adversary types are priceable** — the Daggerheart system has nowhere to record a BP
  cost for a homebrew adversary type, so the module keeps its own table. A custom type can also be
  told to follow an official type's rules. See *Settings* below.
- **Any type can be ignored** — switched off for generation without being removed from a deck, for
  the roles you never want rolled into a fight.

## Installation

Paste this manifest URL into Foundry's *Install Module* dialog:

```
https://raw.githubusercontent.com/el-remito/remito-daggerheart-battle-decks/main/module.json
```

## Usage

1. Open the **Actors** sidebar tab and click **Battle Encounters**. Set your party's tier and size
   at the top of the window — they stick, so this is a first-run job.
2. Click the gear beside *Decks* to open the **Deck Editor**. Create a deck and drag adversaries
   into it. Only `adversary` actors are accepted, and a deck will not take the same adversary twice.
3. Back in the builder, add the decks to draw from: type in the *Decks* search box and click a
   result. Chosen decks collect in the list underneath, each with an ✕ to drop it again. Set the
   modifiers and hit **Generate**. Leave *Target BP* blank to use the budget shown in the field —
   the baseline plus your modifiers.
4. Click a card to open its sheet; drag it onto the canvas to place tokens. Placed cards grey out.
5. **Accept** locks the roster so it cannot drift; the cards stay draggable and the encounter is
   restored the next time you open the window.

## Settings

**Party Tier and # PCs are set in the Battle Encounters window, not in Game Settings.** The window
is the only place they exist, and it remembers whatever you last typed, so they carry over from
one encounter to the next without being configured in two places.

The one entry in *Game Settings → Configure Settings* is **Adversary BP Costs**.

### Adversary BP Costs

The Daggerheart system stores a homebrew adversary type as `{ id, label, description }` — there is
no field for a Battle Point cost anywhere in it, and the system's own encounter maths falls back to
`bpCost ?? 0`. A custom type would therefore be free, and every budget containing one would be
wrong. This window is where you give it a price.

It lists every adversary type the system knows about, built-in and homebrew:

| Column | Meaning |
|---|---|
| Source | *System N* for one of the ten built-in types, *Homebrew* for one you added |
| Treated As | Homebrew only — make this type follow an official type's rules. Not its cost |
| BP Cost | Cost of one at the party's own tier. Blank falls back to the system's value |
| Group per BP | One BP buys a whole group of party-size creatures, the way minions work |
| Ignore | Never draw this type into an encounter |

**Treated As** makes a homebrew type follow an official type's *rules*. Point a *Warbeast* at
*Bruiser* and it counts as a Bruiser everywhere the rules ask, so it revokes the "no Bruisers,
Hordes, Leaders or Solos" bonus. Point one at *Solo* and a pair of them triggers the two-Solos
charge; point one at *Minion* and one Battle Point buys a whole group of them.

It does **not** set the cost. That stays whatever you enter — a type treated as a Bruiser is not
automatically worth 4 BP, and a type with an alias but no cost is still unpriced.

**Ignore** takes a type out of every draw. Decks can still hold it, its cost still applies, and an
encounter that already contains one keeps it — it is simply never picked again, by Generate, by
*Draw Another*, or by a per-card re-roll. Ignore *Social* and a deck of your whole cast will only
ever roll the ones worth fighting. An ignored type also stops being reported as unpriced: it can
never reach a budget, so a missing cost no longer matters.

Only differences from the system's values are stored, so a built-in type you never touch keeps
following the system. Types without a cost sort to the top, are skipped when filling a budget, and
are flagged on the encounter cards rather than being quietly charged 0.

## The Battle Points system

Costs and modifiers come from *Daggerheart Valiran Combat Encounter Calculator.xlsx*, the
homebrew's source of truth. (The spreadsheet is a working reference and is not distributed with
the module.) In short:

```
unit cost   = baseCost(type) x 2 ^ (adversaryTier - partyTier)
baseline    = 3 x PCs + 2
budget left = baseline - sum(adversary costs) + sum(modifiers)
```

Base costs come from the system (`CONFIG.DH.ACTOR.allAdversaryTypes()`) for the ten built-in types,
and from the *Adversary BP Costs* setting for anything the system cannot price.

Modifiers **add** to the budget, so a positive value means a bigger fight is affordable and a
negative one means something is costing you. Six are set by the GM; two are derived from the
encounter's own composition, which is why the budget shifts as adversaries are drawn:

- *Picked 2+ Solo Adversaries?* — `−2` once a second Solo joins.
- *No Bruisers, Hordes, Leaders or Solos?* — `+1` for a fight with no heavy hitters.

That second row is the one place this module does **not** follow the spreadsheet. `Main_v2!M10`
grants the `+1` when a toughie *is* present, which works out as a discount for fielding a big
monster. The v1 sheet, the SRD, and the system's own `BPModifiers.noToughies` all do the opposite,
and that is what ships here — so a Bruiser costs its 4 BP *and* forfeits the bonus.

To confirm the maths after any change, run the spreadsheet's own worked example from the console:

```js
game.modules.get("remito-daggerheart-battle-decks").api.selfTest()
```

## Changelog

### 1.0.1

- **Ignore a type.** New *Ignore* column in *Adversary BP Costs*. An ignored type stays in its
  decks and keeps its cost, but is never drawn — by Generate, by *Draw Another*, or by a per-card
  re-roll. An encounter already holding one keeps it. Ignoring is not inherited through
  *Treated As*, and an ignored type stops being reported as unpriced.
- **Deck picker rebuilt** as a search box over the decks not yet in play, with the chosen decks
  collecting in a scrolling list underneath, each with an ✕. Matching is loose, so `bnd` finds
  *Bandits* and `gob c` finds *Goblin Camp*. A deck deleted while it was selected is now dropped
  from the selection instead of lingering as an unremovable entry.
- **Column alignment.** The Battle Points summary is a fieldset like its two neighbours, so all
  three panels share a border, padding and baseline. Modifier labels sit above their controls
  rather than beside them, which is what let every row size itself differently.
- **Shorter derived rows** in the Battle Points readout — *Picked 2+ Solo*, *No Heavy Hitters* —
  with the full wording on hover.
- **Portraits crop from the top** on encounter cards and deck rows, so a creature's head is no
  longer clipped in favour of its middle.
- Cost-table headers are legible again; they were inheriting a near-black colour over the panel
  fill.

### 1.0.0

Initial release.

## Licence

MIT.
