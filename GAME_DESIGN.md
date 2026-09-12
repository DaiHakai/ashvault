# GAME_DESIGN.md — *Ashvault* (working title)

**Version:** 0.1 (Phase 0 lock)
**Status:** Spec. Phase 1 code must conform to this document. Changes go through this file first.

---

## 0. Design Pillars

Three rules that break ties when a decision is ambiguous:

1. **The dice are the drama.** Every meaningful outcome is a visible roll with visible math. The player should always be able to say "I needed a 14 and got an 11."
2. **Death costs something real.** Permadeath is not a difficulty setting, it is the economy. Everything else (the bank, the hub, the boss gate) exists to give death weight.
3. **Text first, systems second.** If a feature can't be expressed clearly in a scrolling terminal, it's the wrong feature. No feature requires a map, a minimap, or a mouse.

**Explicit non-goals for v1:** real-time combat, PvP, crafting, housing, mounts, voice.

---

## 1. Core Dice Mechanics

**System:** d20 core, deliberately D&D-adjacent so the mental model is free, but not SRD-bound.

### 1.1 Abilities

Six abilities: **STR, DEX, CON, INT, WIS, CHA**.

```
modifier = floor((score - 10) / 2)
```

Scores range 3–18 at creation, hard cap 20.

### 1.2 Stat generation

Roll `4d6, drop lowest`, six times. Player **assigns** results to abilities freely (agency matters when the run can end in 20 minutes). Then apply class bonus (+2/+1) and background bonus (+1).

Server rolls all six sets and returns them as an unassigned pool. **No rerolling the pool** — the pool you get is the character you get. This is the first permadeath lesson, delivered before the player has invested anything.

### 1.3 Resolution

| Roll type | Formula | Success |
|---|---|---|
| Ability check | `d20 + ability mod (+2 if proficient)` | ≥ DC |
| Attack | `d20 + prof + primary mod` | ≥ target AC |
| Saving throw | `d20 + ability mod (+2 if class-proficient)` | ≥ save DC |
| Damage | `weapon/spell die + primary mod` | — |

- **Natural 20** on an attack: critical. Roll damage dice **twice**, add modifier once.
- **Natural 1** on an attack: automatic miss, no damage roll.
- Natural 20/1 have **no** special effect on ability checks or saves — only attacks. (Keeps skill DCs meaningful at high level.)
- **Advantage / Disadvantage:** roll 2d20, take high / take low. Never stacks; sources only ever grant "you have advantage," not "+1 advantage."

### 1.4 Standard DCs

| Difficulty | DC |
|---|---|
| Easy | 8 |
| Moderate | 12 |
| Hard | 16 |
| Very hard | 20 |

Proficiency bonus is **+2 at levels 1–4**, +3 at 5–8. (Level cap for v1 content is 5.)

### 1.5 Server authority

**All rolls that affect game state are generated server-side.** The client never rolls. The client receives a completed `RollResult` and animates it.

```jsonc
// RollResult — the single canonical roll object
{
  "id": "roll_01H...",
  "characterId": "chr_...",
  "notation": "1d20+4",
  "dice": [17],            // raw die faces, in roll order
  "modifier": 4,
  "total": 21,
  "purpose": "attack:bloatrat",
  "vs": 13,                // DC or AC, null if none
  "outcome": "hit",        // hit|miss|crit|fumble|success|failure|null
  "source": "server",      // server | manual
  "verified": true,
  "createdAt": "2026-07-27T12:00:00Z"
}
```

**Manual (physical dice) mode** — Phase 6, but the schema supports it from day one:
- `source: "manual"`, `verified: false`. The player types the faces they rolled; the server still computes modifiers and outcomes.
- Manual rolls are **permitted in solo dungeon content only.** They are rejected by the server in group dungeons, and any character with a manual roll in its history is excluded from leaderboards. Flag lives on the character: `usedManualDice: bool` (sticky, never clears).
- The UI labels these rolls "honour system" inline in the log, every time. No hiding it.

### 1.6 Anti-cheat posture

RNG is `crypto.randomInt`. Every roll is persisted to a `rolls` audit table with its purpose and the resulting state delta. Rate limit: **no character may request more than 30 rolls per 10 seconds**; combat rolls are only issued in response to a legal action in an active encounter, so the client cannot ask for a roll out of band.

---

## 2. Classes

Four at launch. Each has: hit die, primary ability, save proficiencies, a starting kit, and exactly **one** signature ability at level 1 (more at 2/3). One signature ability is enough to give a class an identity in a text game; more is noise.

| Class | Hit die | Primary | Saves | Armour |
|---|---|---|---|---|
| **Blade** | d10 | STR | STR, CON | Chain (AC 16, no DEX) |
| **Stalker** | d8 | DEX | DEX, WIS | Leather (AC 11 + DEX) |
| **Emberwright** | d6 | INT | INT, CHA | Robes (AC 10 + DEX) |
| **Lantern** | d8 | WIS | WIS, CHA | Scale (AC 14 + DEX, max +2) |

**HP at level 1** = max hit die + CON mod. **On level up** = roll hit die + CON mod (minimum 1).

### 2.1 Blade — the one who stands in the doorway
- Ability bonus: +2 STR, +1 CON
- Kit: longsword (1d8), shield (+2 AC), 3 rations, 20 marks
- **L1 — Riposte:** once per encounter, when an enemy misses you, make an immediate attack against it.
- L2 — Second Wind: bonus action, heal `1d10 + level`, once per rest.
- L3 — Cleave: on reducing an enemy to 0 HP, immediately attack another enemy in the room.

### 2.2 Stalker — the one who was never there
- Ability bonus: +2 DEX, +1 WIS
- Kit: shortbow (1d6, ranged), two daggers (1d4), 30ft rope, 25 marks
- **L1 — Mark:** free action, mark one enemy. Your attacks against it have advantage until it dies or you mark another. One mark active at a time.
- L2 — Fade: as an action, become hidden (DC 13 DEX vs the room). Hidden attacks deal +2d6. Breaks on attack.
- L3 — Trapsense: automatic passive check to detect traps; on success the trap is revealed before it triggers.

### 2.3 Emberwright — the one who spends themself
- Ability bonus: +2 INT, +1 CON
- Kit: focus rod, dagger (1d4), spellbook, 15 marks
- Resource: **Embers** = `level + INT mod`, restored on rest.
- **L1 — Cinderbolt:** 1 Ember. Ranged attack, `2d6` fire. On a crit, the target burns: `1d6` at the start of its next two turns.
- L2 — Emberwall: 2 Embers. All allies gain +2 AC until your next turn.
- L3 — Detonate: 3 Embers. `3d6` to every enemy in the room, DEX save (DC `8 + prof + INT`) for half. **Also hits allies.** (Group content, Phase 4 — this is intentional friction.)

### 2.4 Lantern — the one who decides who comes back
- Ability bonus: +2 WIS, +1 CHA
- Kit: mace (1d6), warding lantern, holy sigil, 20 marks
- Resource: **Oil** = `level + WIS mod`, restored on rest.
- **L1 — Kindle:** 1 Oil, action. Heal an ally (or self) `1d8 + WIS mod`.
- L2 — Warding Light: 1 Oil. One ally gains advantage on its next saving throw.
- L3 — **Last Breath:** 3 Oil, reaction. When an ally (not self) would die, they instead drop to 1 HP. **The only mechanic in the game that undoes a death.** Once per character lifetime — not per rest, not per day. Lifetime.

> *Design note:* Last Breath is deliberately the single exception to permadeath, it costs a class slot to access, it can never save the Lantern themself, and it fires once ever. It exists so that a party death has a story beat, not so that death is negotiable.

### 2.10 Grave-Bell — the one who does not accept the answer

*Adopted from the Dark Glory bible's Necromancer, with the one change that makes it playable.*

- Ability bonus: **+2 CHA, +1 CON** — the only CHA weapon, which closes the last gap in the stat table
- Hit die d6 · Grave-wrappings (AC 10 + DEX) · 1d6 ranged · 15 marks
- Resource: **Vitae** = `level + CHA mod`, restored on rest
- **L1 — Raise Thrall:** 1 Vitae, action. Raise the last enemy destroyed this fight at half its original HP and one less to hit. **While it stands, every enemy in the room attacks it instead of you.** One at a time.
- L2 — Siphon: 1 Vitae, action. Ranged attack, `1d8` necrotic, and you heal for half the damage dealt.
- L3 — Second Death: passive. When your Thrall falls it bursts for `2d6` across every enemy in the room.

> *Why not Raise Zombie.* Dark Glory gives the Necromancer *Raise Zombie*, which targets a **Downed ally**. Solo, there are no allies, so the class's entire identity would be inert from level 1 to level 3 — the same trap the Lantern's Last Breath already falls into (§2.4), and one dead signature ability is enough for one game.
>
> **Raise Thrall raises the enemy instead of the ally.** Identical fantasy, identical verb, works alone, and works better in a party. *Raise Zombie* returns as the level 4 ability when Phase 4 brings other players, so the doc's mechanic is deferred rather than discarded.

> *Why it draws fire.* The Thrall is not a damage pet. What you are buying with an action is **a body between you and the room**. That is the whole bargain of the weapon, and it is why a d6 caster with AC 10 survives anything at all.

> *Why you start with a body.* Raise Thrall needs a corpse, so the kit as first written was entirely reactive — you could not use your level-1 ability until you had already killed something, and against a room of three you die before you make the first corpse. **Measured at 1% clear over 250 runs.** The Necromancer now walks in with a **Carrion Servant** (8 HP + 3/level, AC 11) and raises it on turn one; every raise after that needs a real kill. Same weapon at **40%**.

**Measured clear rates**, 300 simulated runs per weapon with a competent bot (`tools/simulate.mjs`):

| Weapon | Clear | Dies mostly at |
|---|---|---|
| Longsword | 51% | the boss |
| Grave-Bell | **40%** | the boss |
| Warhammer | 37% | the boss / the Ossuary |
| Lantern | 25% | the boss |
| Longbow | 18% | the Ossuary |
| Staff | 9% | the Ossuary |

The Grave-Bell lands second because its defence is unconditional while the body stands — and its ceiling is set by **Vitae**, since raises and Siphon draw on the same small pool. Note the Ossuary, not the boss, is what kills the two squishiest weapons; three mutually-buffing Choristers are the real difficulty spike of the dungeon.

---

## 3. Backgrounds

Four at launch. Each gives +1 to an ability, one skill proficiency, one item, and — critically — **a hub hook**: an NPC who reacts to you differently. Backgrounds are how the world acknowledges the player, which is the cheapest possible way to make a text world feel alive.

| Background | +1 | Proficiency | Item | Hub hook |
|---|---|---|---|---|
| **Gravedigger** | CON | Perception | Iron spade (1d6, improvised) | Sister Ambril lets you into the crypt-under-shrine |
| **Caravan Guard** | STR | Athletics | Signal horn (once per dungeon: reroll initiative for the party) | Otho Pell gives you 10% off, grudgingly |
| **Disgraced Scholar** | INT | Arcana | Waterlogged journal (identify one item per dungeon for free) | The Tallyman recognises your name and will not say from where |
| **Gutter Rat** | DEX | Stealth | Bent lockpicks (+2 on lock DCs) | Vess Coldhand waives your first deposit fee, once per account |

### 3.1 Two tracks, and why a pair is a class

A character learns from **both halves**, and the split is what keeps 79 kits from becoming 79 versions of the same fight:

| Track | Owner | Contains | Count |
|---|---|---|---|
| **Active** | the weapon | the things you press in a fight | 3, at levels 1/2/3 |
| **Passive** | the background | how you move through the world | 2, at levels 1/2 |

Background abilities are addressed by **`hook`**, never by background id — the engine asks *"does this character ignore water?"*, not *"is this character a Ferryman?"*. Adding a background that reuses an existing hook needs **no engine change**.

This is the whole trick: **9 weapon tracks + 10 background tracks = 79 distinct kits**, from 19 authored things. `Grave Mage` and `Fen Mage` throw identical fire and survive completely differently.

| Background | Level 1 | Level 2 |
|---|---|---|
| Gravedigger | **Unflinching** — advantage on CON saves | **Deadweight** — +2 damage to anything below half |
| Caravan Guard | **Road Discipline** — +3 initiative | **Escort** — first hit each encounter is halved |
| Disgraced Scholar | **Read the Room** — enemy traits and resistances named on sight | **Marginalia** — once per run, one roll at advantage |
| Gutter Rat | **Light Fingers** — searches never come up empty | **Slip** — first flee each encounter needs no roll |
| Ferryman | **Slack Water** — water never hinders you | **Steady Crossing** — advantage on STR saves |
| Debt Collector | **Ledger** — all marks increased by half | **Call It In** — name a debt, +1d6 on your next hit |
| Mine-Child | **Dark-Adapted** — +1 AC | **Deep Lungs** — the Drowning Song takes half |
| Apostate | **Unbound** — +2 maximum charges | **Recant** — once per run, refill your charges |
| Fenwitch | **Hedge-Craft** — immune to poison | **Second Sight** — advantage on Perception |
| Deserter | **Learned to Run** — +4 to flee | **Survivor's Instinct** — first attack against you has disadvantage |

*Read the Room exists partly to fix a teaching problem: Maugrim's fire resistance used to cost a caster their Embers to discover (§12a).*

### 3.2 Every pair is named by hand

**All 90 titles are written, not generated.** They live in `server/content/titles.json`, keyed `weapon:background`, each with a one-line gloss shown under the name at creation.

The first implementation composed them — `background.titlePrefix + weapon.titleNoun` — which produced 90 rows that read as only **10 families**. Every Gutter Rat was Gutter-something: Gutter Blade, Gutter Mage, Gutter Knife. The background swallowed the identity and the weapon was demoted to a suffix, so the grid felt like ten classes with a decoration rather than ninety classes.

Written titles cost 90 lines of content once, and they buy the thing the whole weapon × background system exists for:

| Weapon | Gutter Rat | Apostate | Ferryman |
|---|---|---|---|
| Longsword | Bravo | Recreant | Tidesworn |
| Warhammer | Bruiser | Templebreaker | Anchorhand |
| Longbow | Roofrunner | Excommunicate | Farbank |
| Paired Daggers | Shiv | Defiler | Linecutter |
| Staff | Trickster | Heresiarch | Riverwright |
| Bound Tome | Forger | Apocryphon | Logkeeper |
| Warding Lantern | Snuffer | *(refused)* | Beaconman |
| Chain Censer | Ashthief | Defrocked | Mistbringer |

**Rules this locks in:**

1. All 90 exist, **including the 11 forbidden pairs** — lifting a prohibition must never leave a hole.
2. A missing title throws. There is no generated fallback, because a fallback would silently reintroduce the family problem.
3. No two titles may share a first word within a background, or a last word within a weapon. Enforced by test — it is the specific failure mode being designed against.

*Adding a weapon now costs 10 names; adding a background costs 9. That is the real price of the multiplicative design, and it is worth paying.*

### 3.3 Four ship, six wait

The grid is deliberately scoped for now: **4 backgrounds ship, 6 are locked.**

| | Count |
|---|---|
| Backgrounds authored | 10 |
| Backgrounds selectable | **4** — Gravedigger, Caravan Guard, Disgraced Scholar, Gutter Rat |
| Combinations shipped | 4 × 9 = 36, minus 4 prohibitions = **32 playable** |
| Combinations authored and waiting | 79 |

The four that ship are the design doc's original set — the ones with the oldest hub hooks into named NPCs.

**Locked, not deleted.** Every held-back background keeps its prologue, ability track, hub hook, and all nine of its titles. Unlocking one is a single flag in `backgrounds.json`:

```json
"ferryman": { "locked": true, "lockedNote": "The Last Crossing opens in a later chapter." }
```

Delete that line and the Ferryman is live — **no writing, no code**. A test asserts every locked background is complete enough for exactly that, so the flag can never rot into a half-finished background.

**Why lock rather than cut:** the reason to reduce the grid was that hand-written titles make expansion cost writing (§3.2). Locking gets the benefit — adding a 10th weapon now costs **4 names instead of 10** — without throwing away work already done. It also converts a content decision into a release decision, which is the cheaper kind.

Three rules:

1. Locked backgrounds are **rejected server-side** at character creation, not merely hidden. The client is never the gate.
2. Their titles are **not shipped to the client** — no advertising a name the player cannot roll.
3. They still appear on the creation screen, dimmed and dashed, tagged *a later chapter*. Six visible-but-waiting reads as scope; six missing reads as a small game.

### 3.4 What a past will not carry

Most pairs are legal. A few are not, in the WoW dwarf-druid sense — **11 prohibitions out of 90, leaving 79 playable pairs.**

This is deliberately a short **forbidden list**, not a sparse allow-list. Restrictions should make the world feel like it has opinions, not shrink the character system; if the legal share ever drops below ~80% the rule has stopped paying for itself. There is a test asserting exactly that.

| Background | Will not carry | Because |
|---|---|---|
| Gravedigger | Bound Tome | Never learned their letters |
| Caravan Guard | Staff | Every company contract forbids unlicensed fire near a cargo |
| Disgraced Scholar | Warhammer | Has never swung anything heavier than an argument |
| Gutter Rat | Spear | You cannot take a nine-foot pole through a second-storey window |
| Ferryman | Warhammer | Weight is the enemy on the water |
| Debt Collector | Longbow | Collection is done at conversational distance |
| Mine-Child | Longbow | No gallery below the cut is long enough to loose in |
| Apostate | Warding Lantern, Chain Censer | Consecrated by people they walked out on |
| Fenwitch | Chain Censer | Church iron, and the church keeps a list |
| Deserter | Spear | Left the pike upright in the mud with the standard |

**Every prohibition carries its reason in the content**, and the creation screen shows the refusal rather than hiding the option. A restriction the player understands is world-building; one they do not is a bug report.

---

## 4. Combat Resolution

Combat is **turn-based, room-scoped**. Every enemy in a room is in the encounter; there is no positioning grid. Range exists only as a binary tag (`melee` / `ranged`) used by a small number of abilities.

### 4.1 Turn order

Initiative = `d20 + DEX mod`, rolled once at encounter start, descending. Ties broken by higher DEX, then by roll ID (stable). Order is fixed for the whole encounter.

### 4.2 A turn

One **action** + one **bonus action** (if the character has one available) + free actions (Mark, speaking, dropping an item).

Actions: `attack`, `ability <name> [target]`, `use <item>`, `defend` (+2 AC until your next turn), `flee`.

### 4.3 Damage & death

```
attack:  d20 + prof + primaryMod  vs  target.ac
damage:  weaponDie + primaryMod   (crit: dice twice, mod once)
```

- **0 HP is death.** No death saves, no bleed-out timer, no downed state. The character is marked `dead` server-side in the same transaction that applied the damage.
- The only exception is a Lantern's **Last Breath** (§2.4), which resolves as a reaction *before* the death is committed.
- Damage in excess of 0 is discarded (no overkill tracking in v1).

### 4.4 Fleeing

`flee` → DC 12 DEX check.
- **Success:** you leave the encounter and return to the previous room. Enemies remain at their current HP and re-engage if you re-enter — you cannot heal-and-repeat for free.
- **Failure:** every enemy in the room makes one immediate attack against you, and you remain in the encounter.
- **You cannot flee a boss room.** The door is barred behind you on entry. State this in the room text before the fight starts, not after.

### 4.5 Rest

`rest` is available only at designated **shrine** nodes (one per dungeon, §5.2 Room 5).
- Restores HP to full, restores Embers/Oil, restores per-encounter abilities.
- Using a shrine **consumes** it — one rest per dungeon run, and the dungeon does not repopulate.

### 4.6 XP and levels

Milestone-flavoured but numeric, so kills feel earned.

| Level | XP | Expected point in dungeon 1 |
|---|---|---|
| 1 | 0 | start |
| 2 | 60 | during the Ossuary (after the 2nd Chorister) |
| 3 | 90 | at the boss door (on the last Chorister) |
| 4 | 400 | (post-hub content) |
| 5 | 800 | (post-hub content) |

> *Corrected in implementation (Phase 1):* level 3 was originally written as 180 XP, but the dungeon only contains **90 XP** of pre-boss encounters (10 tutorial + 20 Cistern + 60 Ossuary), so 180 was unreachable before Maugrim and the stated pacing was impossible. Level 3 is 90. Levels 4 and 5 keep their original thresholds so Maugrim's 150 XP lands the character at level 3 and no further. The optional Fungal Gallery deliberately awards **no** XP — it rewards an item, not power, so the boss-door level is the same for every player.

Enemy XP: Bloatrat 10, Bone Chorister 20, Warren Stalker 30, **Maugrim 150**.
Level cap for v1 content: **5**.

---

## 5. World Structure

```
        [Character Creation]
                │
   ┌────────┬───┴────┬────────────┐      Four prologues. A player only ever
   ▼        ▼        ▼            ▼      sees the one their class was
 BLADE    STALKER  EMBERWRIGHT  LANTERN  written for.
"The     "The     "The         "The
 Held     Cold     Debt"        Vigil"
 Door"    Trail"
   └────────┴────────┴────────────┘
                │
                ▼
        THE FIRST CAMP        (convergence — safe, one free rest,
                │              the last free thing)
                ▼
      The Sunken Warrens      (dungeon 1 — 6 nodes, permadeath live)
                │  defeat Maugrim
                ▼
            ◆ PORTAL ◆
                │
                ▼
            ASHVAULT          (persistent hub — chat, bank, shops, parties)
                │
                ▼
      [Phase 4+ : group dungeons, further zones]
```

### 5.1 The prologues — one per class

**Every class has its own story, and it runs from character creation to the First Camp.** Nothing before the camp is shared. This is the only stretch of the game authored specifically for who the player chose to be, and it is deliberately the stretch where they are deciding whether they care.

Each prologue is **three rooms, one encounter, one search**, and teaches `look`, `move`, `attack`, `search`, `inventory`. Each has its own enemy, so the fight reads as part of that story rather than a shared tutorial monster.

| Class | Prologue | Premise | Encounter |
|---|---|---|---|
| **Blade** | *The Held Door* | You held a doorway from the third bell to the ninth. Nobody came to relieve you. | **Gate Wight** — your own house's gatekeeper, still at its post |
| **Stalker** | *The Cold Trail* | Four days tracking something, and the track has started doubling back inside your own bootprints. | **Warren Shrike** — it has been pacing *you* for two miles |
| **Emberwright** | *The Debt* | Your workshop burned because you were tired and certain. The rod is still warm six days later. | **Cinder Moth** — the part of your fire that got away |
| **Lantern** | *The Vigil* | Nine nights sitting up with the dead, and on the ninth the lantern leaned toward the door on its own. | **Grief Shade** — someone still waiting up for somebody |

**Death in a prologue is still permanent**, and the game says so plainly in the first room. That sets the contract inside sixty seconds, before the player has invested anything.

### 5.1a The First Camp (convergence)

Forty people and one fire in a hollow under the roots of everything, with a member of each class visible in it — so the player meets the other three stories as strangers rather than as menu options.

- **Non-combat zone.** Nothing here can reduce HP.
- **One free rest**, a full restore. It does **not** consume the dungeon shrine (§4.5): the camp sits outside the dungeon, so the one-rest-per-dungeon rule is untouched.
- Exactly one exit: north, into the Warrens.

The camp is where the game stops being about you specifically:

> *"This is as far as your own story goes. Through the mouth in the north wall it is the same story for all of you."*

From here on the content is shared, which is precisely what makes it schedulable as group content in Phase 4. **Everything past the camp is standard MMO structure** — shared world, shared dungeons, shared hub — and the per-class writing budget is spent entirely in front of it.

### 5.2 The Sunken Warrens (dungeon 1)

Linear with one optional branch. Node graph:

| # | Node | Content |
|---|---|---|
| 1 | **The Threshold** | No combat. Loot: 1 minor item. Exits: 2 |
| 2 | **The Cistern** | 2× Bloatrat. Water: `flee` DC +2 here |
| 3 | **Fungal Gallery** *(optional)* | Skill challenge — WIS (Perception) DC 12 to spot sporecaps. Success: 1 Uncommon item. Failure: `2d6` poison, no item |
| 4 | **The Ossuary** | 3× Bone Chorister. They buff each other; killing one weakens the rest |
| 5 | **The Wardroom** | **Shrine.** Rest node. Merchant corpse: 40–80 marks |
| 6 | **The Drowned Throne** | **BOSS: Maugrim.** No flee. No exit until resolved |

Rooms 2 and 4 are the "2–3 encounters" of the Phase 1 MVP. Room 3 exists to prove the skill-check path works and gives non-combat builds something to do.

### 5.3 Enemies

Prologue enemies (§5.1) sit below all of these — 5–7 HP, AC 11–14, ~`1d4` damage, 10 XP each.

| Enemy | HP | AC | Attack | Damage | Notes |
|---|---|---|---|---|---|
| Bloatrat | 6 | 12 | +3 | 1d4+1 | On death: bursts, DC 11 CON or `1d4` |
| Bone Chorister | 9 | 13 | +2 | 1d6 | **+1 to hit** per other living Chorister |
| Warren Stalker | 22 | 15 | +5 | 2d6 | Advantage vs targets that acted last in initiative. **Defined but unplaced** — held for dungeon 2 |

> *Rebalanced in implementation (Phase 1).* The original figures were party-scaled. Simulated against solo characters they produced a **0% clear rate over 800 runs**: the Ossuary alone dealt 35–86 expected damage to characters with 7–12 HP. The Chorister buff was also cut from "+1 to hit **and damage**" to to-hit only — at three Choristers the damage half spiked hard enough to one-round every class but the Blade. See §12a for the full record.

### 5.4 Boss — Maugrim, the Tidewarden

**HP 40 · AC 15 · Init +2 · Attack +5 · Damage 2d6+3**

Three phases, gated on HP. The chamber floods.

- **Phase 1 (40→28 HP):** Standard attacks. Every third turn: *Undertow* — all players make DC 13 STR saves or lose their action next turn. Undertow **replaces** the attack on that turn rather than stacking with it.
- **Phase 2 (27→14 HP):** Water rises. Melee attacks take **−2** unless the attacker spends an action to climb the central plinth. Maugrim gains resistance to fire (Emberwright's Cinderbolt halved) — this is the moment the Emberwright's obvious answer stops working, and playing around it is worth roughly 3× that class's clear rate.
- **Phase 3 (13→0 HP):** *Drowning Song.* At the start of each of Maugrim's turns, every player takes `1d6` and must make a DC 14 CON save or have their max HP reduced by that amount for the rest of the run. It becomes a damage race, and it is meant to be genuinely lethal to a solo level-3 character who arrives without their shrine rest.

Phase 1's opening text fires when the encounter starts, not on a transition — otherwise it is content no player ever sees.

**On defeat:**
- 150 XP (takes the character to level 3 and no further)
- **Tidewarden's Seal** (Rare, always drops) — the hub key item
- 1 roll on the boss loot table (Drowned Crown / Tidecleaver / Warden's Robe)
- Character flag `hubUnlocked = true`, permanently, for that character only
- **The portal opens.** The chamber has no exits at all until Maugrim is down; on victory a `portal` exit appears and leads to Ashvault. `MOVE PORTAL` is the last command of Phase 1.

---

## 5.5 The Hollow Crypt — the second dungeon

*Adopted from the Dark Glory bible §5, placed as post-hub content rather than as a replacement.*

**Why second, not first.** The Sunken Warrens is balanced against 800 simulated runs, and that measurement is the expensive part. Swapping the gate dungeon would throw it away for no gain, while post-hub content was completely empty. So beating Maugrim now opens **two** exits: `PORTAL` to Ashvault, or `DOWN` into the Crypt. Take the win, or push.

```
  Crypt Entrance          no encounter — the water stops, all at once
        |
  Bone Antechamber        2x Skeletal Husk        -- then the hall forks --
        |
    +---+------------------------+
   WEST                        EAST
  Collapsed Passage         The Rift Room     (no choice: it pulls you)
  3x Grave Wisp                  |
        |                 The Bleeding Hollow — 1x The Wight, one way only
        +------------+-----------+
                     |
  Sanctum Antechamber     shrine, and the passage behind you seals
                     |
  The Warden's Sanctum    BOSS: The Withered Warden
```

**The Rift.** Entering is the whole event — no prompt, no saving throw, because it is meant to read as a hazard rather than a fork. Solo it pulls the only person present, so it degrades gracefully into a committed one-way side route with a harder fight and better loot. In Phase 4 the same room pulls a subset of the party and genuinely splits it, exactly as the bible describes.

**Both paths are worth the same XP (90)**, so the boss-door level is identical whichever you take. West is three fragile, hard-to-hit wisps; east is one elite that heals off you.

| Enemy | HP | AC | Attack | Damage | Note |
|---|---|---|---|---|---|
| Skeletal Husk ×2 | 10 | 13 | +4 | 1d6+1 | |
| Grave Wisp ×3 | 8 | 16 | +5 | 1d6 | Hard to hit; hits back for little |
| **The Wight** | 32 | 14 | +6 | 1d10 | **Heals for half the damage it deals** |

### The Withered Warden

**HP 70 · AC 16 · Attack +7**

- **Phase 1 — The Keeping (70→36):** `2d8+3`. A straight brute, no gimmicks. It teaches the fight.
- **Phase 2 — Devour (35→0):** the attack is *replaced* by **Devour** — `2d6`, and **it heals for half of what it deals.** The damage drops and the fight gets harder, because now you are racing its healing rather than its damage.

Devour deliberately mirrors the Grave-Bell's *Siphon* (§2.10) and the Wight's drain: the same verb, pointed at you. It ties the boss to the game's spine instead of being a one-off gimmick.

**Drops:** the **Warden's Key** always, plus one roll on a table of three **Epic** items — the first Epics in the game, which is what makes the rarity curve (§6b) matter.

**It does not unlock anything.** Only the gate boss grants hub access; the Crypt is optional content past it. Beating the Warden opens one exit: back up the stair, past everything you already killed.

**Measured**, 200 runs per weapon per path, entering at level 4 with full HP (`tools/crypt-sim.mjs`):

| Weapon | West (Wisps) | East (Rift) |
|---|---|---|
| Longsword | 28% | 23% |
| Lantern | 22% | 27% |
| Grave-Bell | 6% | 9% |

Roughly half the Warrens' clear rate, which is right for content you reach *after* the gate boss. The Warden is the wall in every case.

> *The Grave-Bell's weak matchup is deliberate and worth keeping.* It reaches the Warden almost every run — only 1 death in 200 happened before the boss — and then loses, because a lone boss produces no corpses and Raise Thrall has nothing to work with beyond the one carried body. The Necromancer is a crowd weapon that struggles against a single enemy. That is class identity, not a balance bug, and it should not be smoothed away.

---

## 6. Permadeath Rules

The single most important table in this document. **What survives a death:**

| Thing | Survives? | Notes |
|---|---|---|
| The character | ❌ | Marked `status: 'dead'`, never resumable, stays visible on the account's memorial list |
| Character level & XP | ❌ | Full reset. New character starts at level 1 |
| Carried inventory | ❌ | Destroyed. Not dropped, not recoverable, no corpse run |
| Carried marks (gold) | ❌ | Destroyed |
| **Bank vault (2 slots)** | ✅ | Account-linked. Survives any number of deaths |
| **Dice sets / cosmetics** | ✅ | Account-linked. Purely visual |
| **Achievements & leaderboard entries** | ✅ | Account-linked |
| **Hub access** | ❌ | **Per character.** Every new character must beat Maugrim again |

The last row is the whole design. The bank is an account-wide safety net that you must **re-earn access to on every single run.** Your best item is sitting in a vault two zones away and you cannot touch it until you've cleared the boss that killed you last time.

### 6.1 Death is atomic

Death is committed in the same database transaction as the killing blow. There is no window in which a client can act on a dead character. On death the server:
1. Sets `character.status = 'dead'`, `diedAt`, `killedBy`, `deathRoom`
2. Deletes carried inventory rows (logged to `death_log` for the memorial, not recoverable)
3. Terminates any active party membership
4. Emits `character:died` over Socket.io to the character's session and any party members

### 6.2 No revives

There is no resurrection item, no revive purchase, and no "restore character" support path. The only mechanic that touches death is Lantern's Last Breath (§2.4), which prevents a death rather than reversing one.

---

## 6b. Items & Rarity

*Adopted from the Dark Glory bible §7.*

Before this, **rarity did nothing** — it was a label that set the bank's deposit fee and nothing else, so a Rare sword and a Common one hit exactly as hard and the loot table was decorative.

| Rarity | Weapon bonus |
|---|---|
| Common | +0 attack / +0 damage |
| Uncommon | +1 / +1 |
| Rare | +2 / +2 |
| Epic | +3 / +3 |

**Weapons only.** Defensive items carry their tier directly in their own hand-tuned `ac` value; adding a rarity bonus on top would double-count and quietly inflate AC past what the encounters are balanced against. A test asserts the Tidewarden's Seal contributes exactly its own `ac` of 1 and nothing more.

**The trinket slot stays.** Dark Glory drops trinkets and keeps only weapons / armour / consumables, but it does so for a shop-UI reason — it has two shopkeepers and no third slot. Dropping the slot here would orphan all three of Maugrim's rare drops *and* the Tidewarden's Seal, which is the hub key item. Trinkets therefore drop but are not sold.

---

## 6c. Sound

Two layers, deliberately different in kind.

**Music — real files.** Six CC0 tracks in `public/audio/`, looped and crossfaded per zone. CC0 is public domain: **no attribution is owed and none is displayed.** Sourced from OpenGameArt.

| Zone | Track |
|---|---|
| Prologue | `dungeon002_0.ogg` |
| The Descent | `dark_cavern_ambient_002.ogg` |
| First Camp / Ashvault | `cold_silence.ogg` |
| Sunken Warrens | `dark_cavern_ambient_001.ogg` |
| Hollow Crypt | `bleeding_out2_2.ogg` |
| Boss rooms | `blackout_3mzut0qtwao.mp3` |

> *The first version synthesised the ambience in-browser and it was rejected on hearing, correctly: stacked low sine drones over a filtered noise bed sound like a buzz, because that is literally what they are. Generated ambience is a fine idea and a bad result. Music is the one thing here worth shipping bytes for.*

**Cues — still synthesised.** Roughly fifteen one-shots built from filtered noise and enveloped oscillators: dice on stone, a hit, a crit, a miss, the Grave-Bell. These stay generated because they are short, dry, and have to fire the instant a roll resolves — loading and decoding a file per die roll would be worse in every way.

The client picks cues by **reading the log text it already renders**, so the game engine never has to know sound exists. **M** toggles everything, and the choice persists.

> *Implementation note:* the music crossfade runs on a `setInterval` driven by the wall clock, not `requestAnimationFrame`. rAF is suspended entirely while a tab is hidden, so a fade begun just before the player switched away never completed and the track sat silently at volume 0 for the rest of the session.

---

## 7. Bank System (Ashvault Vault)

Run by **Vess Coldhand**. Located in the hub, therefore reachable only by a character who has beaten Maugrim.

### 7.1 Rules

- **2 slots. Account-wide. Hard cap.** No expansion, no purchasable third slot, ever. Scarcity is the feature.
- One item per slot. Stacks do not compress — 5 potions is 5 items and will not fit.
- **Deposit costs marks, scaled by rarity. Withdrawal is free.**

| Rarity | Deposit fee |
|---|---|
| Common | 25 marks |
| Uncommon | 75 marks |
| Rare | 200 marks |
| Epic | 500 marks |

> *Rationale for charging on deposit only:* it puts the entire decision at one moment — "is this worth 200 marks and one of my two slots?" — while the player still has an alternative (sell it to Otho, use it now). A withdrawal fee would just tax you for playing at all and would create a horrible failure state where your item is stranded because you're broke.

- **Swapping** a slot's contents = withdraw (free) + deposit the new item (full fee). No discount for swapping.

### 7.2 The reservation question — **decided: no reservation**

Your roadmap flagged this as open. The decision:

**Banking is in-person and hub-only.** There is no remote deposit, no "queue at death", no deposit-on-death insurance. If an item was not physically deposited with Vess before you died, it is gone.

This dissolves the ambiguity rather than answering it — with no remote deposit there is no queued item and no contested slot, so "reserved vs first-come at hub arrival" never arises. Vault contents are exactly what was deposited, and they sit there indefinitely.

*(Rejected alternative: allowing remote deposit via a consumable "courier scroll." It's a good item and would be fine to add in Phase 5+, but it re-opens the reservation question and lets players trivialise the run-back tension. Not in v1.)*

### 7.3 Dying mid-transaction

Not possible to reach a broken state:
- Deposit and withdrawal each run as **a single database transaction** (`BEGIN … COMMIT`). An item is in the vault or in inventory, never both, never neither.
- The hub is a **non-combat zone** — nothing in the hub can reduce HP, so there is no in-hub death vector at all.
- If the socket drops mid-request, the transaction either committed or rolled back before the response was written. On reconnect the client re-fetches authoritative state; it never replays a local guess.

---

## 8. Hub NPC Roster (Ashvault)

Ashvault is a flooded city built on the drained upper levels of the Warrens. Everyone here got in the same way the player did, and they all know it. **The unifying tone: these are survivors running a business, not quest-dispensers.**

| NPC | Role | Voice |
|---|---|---|
| **Vess Coldhand** | Banker | Ex-mercenary, missing three fingers. Flat, transactional, zero sentiment about your dead characters. Counts your fee out loud. Will say exactly one kind thing if you reach level 5. |
| **Otho Pell** | General goods, buy/sell | Enormously friendly, exhaustingly so. Remembers your dead characters by name and asks after them. Does not appear to understand that this is upsetting. |
| **Sister Ambril** | Shrine, healing, memorial | Gentle, entirely unsentimental about death — she has processed thousands. Maintains the memorial wall listing every character the account has lost. |
| **The Tallyman** | Bounty board / quest-giver | Speaks only in ledger terms ("your column is short"). Never states what he is owed. Sole source of repeatable objectives from Phase 5. |
| **Kesh** | Dice merchant *(Phase 6)* | Compulsive gambler, warm, disastrous with money. Sells and unlocks dice skins. Will offer a double-or-nothing on your fee that the shop UI cheerfully lets you take. |

Every NPC has a **background reaction line** for each of the four backgrounds (§3) — 20 lines total, written once, permanently makes the hub feel like it knows you.

---

## 9. Data Schema

PostgreSQL. Written for Phase 2 but shaped so Phase 1 can run the same objects in memory.

```sql
-- ============ ACCOUNT LAYER (survives permadeath) ============

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,               -- argon2id
  display_name  text UNIQUE NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

CREATE TABLE bank_vaults (                    -- exactly one per account
  account_id  uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  slot_count  smallint NOT NULL DEFAULT 2 CHECK (slot_count = 2)
);

CREATE TABLE bank_slots (
  vault_id    uuid REFERENCES bank_vaults(account_id) ON DELETE CASCADE,
  slot_index  smallint NOT NULL CHECK (slot_index IN (0, 1)),
  item_id     uuid REFERENCES item_instances(id) ON DELETE SET NULL,
  deposited_at timestamptz,
  fee_paid    integer,
  PRIMARY KEY (vault_id, slot_index)
);

CREATE TABLE dice_sets (                      -- catalogue, cosmetic only
  id          text PRIMARY KEY,               -- 'bone', 'tidewarden', 'ashglass'
  name        text NOT NULL,
  unlock_type text NOT NULL,                  -- achievement | drop | currency
  unlock_ref  text
);

CREATE TABLE account_dice_sets (
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  dice_set_id text REFERENCES dice_sets(id),
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, dice_set_id)
);

CREATE TABLE achievements (
  account_id  uuid REFERENCES accounts(id) ON DELETE CASCADE,
  key         text NOT NULL,
  earned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key)
);

-- ============ CHARACTER LAYER (destroyed on death) ============

CREATE TYPE character_status AS ENUM ('alive', 'dead');

CREATE TABLE classes (
  id          text PRIMARY KEY,               -- blade | stalker | emberwright | lantern
  name        text NOT NULL,
  hit_die     smallint NOT NULL,
  primary_ability text NOT NULL,
  save_proficiencies text[] NOT NULL,
  starting_kit jsonb NOT NULL
);

CREATE TABLE backgrounds (
  id          text PRIMARY KEY,               -- gravedigger | caravan_guard | scholar | gutter_rat
  name        text NOT NULL,
  ability_bonus text NOT NULL,
  skill_proficiency text NOT NULL,
  starting_item text,
  hub_hook    text NOT NULL
);

CREATE TABLE characters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          text NOT NULL,
  class_id      text NOT NULL REFERENCES classes(id),
  background_id text NOT NULL REFERENCES backgrounds(id),

  level         smallint NOT NULL DEFAULT 1,
  xp            integer  NOT NULL DEFAULT 0,
  hp_current    integer  NOT NULL,
  hp_max        integer  NOT NULL,
  hp_max_penalty integer NOT NULL DEFAULT 0,  -- Maugrim phase 3

  str smallint NOT NULL, dex smallint NOT NULL, con smallint NOT NULL,
  int smallint NOT NULL, wis smallint NOT NULL, cha smallint NOT NULL,

  resource_current smallint NOT NULL DEFAULT 0, -- Embers / Oil
  resource_max     smallint NOT NULL DEFAULT 0,
  marks         integer NOT NULL DEFAULT 0,

  status        character_status NOT NULL DEFAULT 'alive',
  hub_unlocked  boolean NOT NULL DEFAULT false,   -- PER CHARACTER. Never copied forward.
  used_manual_dice boolean NOT NULL DEFAULT false, -- sticky, excludes from leaderboards
  last_breath_used boolean NOT NULL DEFAULT false, -- lifetime, Lantern only

  current_zone  text NOT NULL DEFAULT 'undercroft',
  current_room  text NOT NULL DEFAULT 'stair_1',

  created_at    timestamptz NOT NULL DEFAULT now(),
  died_at       timestamptz,
  killed_by     text,
  death_room    text
);

CREATE INDEX ON characters (account_id, status);

-- ============ ITEMS ============

CREATE TYPE item_rarity AS ENUM ('common', 'uncommon', 'rare', 'epic');

CREATE TABLE items (                          -- templates
  id          text PRIMARY KEY,
  name        text NOT NULL,
  rarity      item_rarity NOT NULL,
  slot        text,                           -- weapon|armour|trinket|null (consumable)
  stats       jsonb NOT NULL DEFAULT '{}',    -- {damage:"1d8", ac:2, ...}
  base_value  integer NOT NULL DEFAULT 0,
  description text NOT NULL
);

CREATE TABLE item_instances (                 -- an actual object in the world
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     text NOT NULL REFERENCES items(id),
  owner_character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
  equipped    boolean NOT NULL DEFAULT false,
  -- exactly one of owner_character_id / bank slot reference is non-null
  CHECK (owner_character_id IS NOT NULL OR equipped = false)
);

-- ============ SOCIAL / WORLD ============

CREATE TABLE parties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  zone        text NOT NULL DEFAULT 'ashvault',
  max_size    smallint NOT NULL DEFAULT 4,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE party_members (
  party_id     uuid REFERENCES parties(id) ON DELETE CASCADE,
  character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, character_id)
);
CREATE UNIQUE INDEX ON party_members (character_id);  -- one party at a time

CREATE TABLE world_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,                  -- invasion | announcement | boss_slain
  payload     jsonb NOT NULL,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz,
  active      boolean NOT NULL DEFAULT true
);

CREATE TABLE npcs (
  id          text PRIMARY KEY,               -- vess | otho | ambril | tallyman | kesh
  name        text NOT NULL,
  role        text NOT NULL,
  zone        text NOT NULL,
  dialogue    jsonb NOT NULL                  -- {greeting, byBackground:{...}, lines:[...]}
);

-- ============ AUDIT ============

CREATE TABLE rolls (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
  notation     text NOT NULL,
  dice         smallint[] NOT NULL,
  modifier     integer NOT NULL,
  total        integer NOT NULL,
  purpose      text NOT NULL,
  vs           integer,
  outcome      text,
  source       text NOT NULL DEFAULT 'server' CHECK (source IN ('server','manual')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON rolls (character_id, created_at DESC);

CREATE TABLE death_log (                      -- the memorial wall
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  character_name text NOT NULL,
  class_id     text NOT NULL,
  level        smallint NOT NULL,
  killed_by    text NOT NULL,
  room         text NOT NULL,
  carried_items jsonb NOT NULL,               -- what was lost, for flavour
  died_at      timestamptz NOT NULL DEFAULT now()
);
```

### 9.1 Schema invariants (enforce in code, test in Phase 2)

1. An `item_instance` is owned by **at most one** of: a character's inventory, or a bank slot. Never both.
2. `characters.hub_unlocked` is never set from another character's value. It is set exactly once, by the Maugrim kill handler.
3. `characters.status = 'dead'` is a terminal state. No update may set it back to `'alive'`.
4. An account may have **at most one** `status = 'alive'` character at a time (v1 rule — keeps permadeath meaningful; revisit if alt-characters are ever wanted).
5. Every state-changing roll writes a `rolls` row in the same transaction as the state change.

---

## 10. Command Grammar (Phase 1)

Parser is verb-first, tolerant of articles, case-insensitive.

```
look [target]              l
move <exit> | go <exit>    n/s/e/w as shortcuts
search                     turn the room over (loot and skill challenges)
attack <enemy>             a <enemy>  |  bare `attack` targets the lowest-HP enemy
ability <name> [target]    use <name> [on <target>]
defend                     +2 AC until your next turn
pass                       do nothing and end your turn
climb / descend            the boss-room plinth
inventory                  i
equip <item> / unequip <item>
use <item>
rest                       (camp and shrine nodes only)
flee
sheet                      character sheet
restart                    only when dead
help
```

`search`, `climb`/`descend`, `pass` and `restart` were added during Phase 1. `search` in particular is deliberately its own verb rather than an outcome of `look`: the Fungal Gallery (§5.2) can poison you for `2d6`, and punishing the safe exploration verb would teach players not to explore.

Unknown input returns a suggestion, never a bare error: `"I don't know 'atack'. Did you mean: attack?"`

---

## 11. Open Questions Deliberately Left Open

Everything your Phase 0 list flagged is now decided. These are the ones I'm *choosing* to defer, with the phase they must be answered by:

| Question | Must answer by |
|---|---|
| Loot distribution in group dungeons (need vs greed vs round-robin vs personal loot) | Phase 4 |
| Party wipe handling — does the whole party die, or does the instance eject survivors? | Phase 4 |
| Whether marks are tradeable between players (economy exploit risk with permadeath alts) | Phase 5 |
| Dice set unlock pacing and whether any are purchasable with real money | Phase 6 |
| Guild system scope | Phase 7 |

---

## 12. Phase 1 Definition of Done

Phase 1 is complete when a single player can, in one browser session with no login:

- [ ] Create a character (name, class, background) with server-rolled 4d6-drop-lowest stats they assign
- [ ] Play their class's own prologue and arrive at the First Camp
- [ ] Traverse all 6 Sunken Warrens nodes using the §10 command grammar
- [ ] Fight both standard encounters and the optional skill challenge
- [ ] Rest once at the Wardroom shrine
- [ ] Fight Maugrim through all three phases
- [ ] Die at 0 HP anywhere and be shown a death screen with the memorial entry, with no way to resume
- [ ] Beat Maugrim and see `hubUnlocked = true` on the character sheet
- [ ] See every roll in the log with full visible math (`1d20+4 → [17]+4 = 21 vs AC 13 — HIT`)

No accounts, no database, no sockets, no functioning hub. Those are Phases 2 and 3.

---

## 12a. Balance Record (Phase 1)

Kept because the next person to touch these numbers needs to know they were measured, not guessed. All figures are from simulated runs of the real `GameSession`, 300 runs per class, with a bot that heals between fights, uses class resources, and plays around Maugrim's fire resistance.

**Starting point: 0 clears in 800 runs.** The spec's numbers were party-scaled; Phase 1 is solo.

| Change | Reason |
|---|---|
| Level-1 HP `+5` flat (`SOLO_HP_ALLOWANCE`) | A level-1 Emberwright had 7 HP against enemies dealing 4–6 per hit. Two-hit kills were routine |
| Level-up HP `+3` flat (`LEVEL_HP_ALLOWANCE`) | Deaths clustered at levels 2–3, which the level-1 constant never reached |
| Level 2 at 30 XP, not 60 | At 60, the Ossuary — the hardest pre-boss fight — was fought at level 1. The frailer classes could not win it at full HP with perfect play |
| Bloatrat and Chorister damage/HP cut | See §5.3 |
| Chorister buff is to-hit only | The damage half made three of them one-round everything but the Blade |
| Maugrim 60→40 HP, `2d8+3`→`2d6+3`, `+6`→`+5` | The boss was a 100% wipe even for characters who reached it healthy |
| Rations in **every** class kit; ration heal `1d4`→`1d6` | Only the Blade's kit contained any healing at all. The three other classes had no sustain whatsoever |
| Focus Rod and Warding Lantern became **weapons** (1d8, INT / WIS) | The Emberwright's and Lantern's kit weapons keyed off abilities those classes dump, so once their resource ran out they had no attack |
| Cinderbolt adds the INT modifier | At flat `2d6` a 1-Ember Cinderbolt was *weaker* than swinging the free rod. A signature ability should not be strictly worse than the default |
| Warded Robes 10→13, Studded Leather 11→12 | With no positioning in a text game, ranged classes get no defensive benefit from range, so AC has to carry it |

**Result — clear rate with competent play:**

| Class | Clear rate |
|---|---|
| Blade | ~63% |
| Stalker | ~31% |
| Lantern | ~26% |
| Emberwright | ~14% |

The spread is intentional and matches the fiction — the Blade is the forgiving class, the Emberwright is the punishing one — but **the Emberwright is on the edge of acceptable and should be watched.** Its clear rate more than tripled purely from playing the fire resistance correctly, so some of the gap is a teaching problem rather than a numbers problem: the game does not currently tell the player that Maugrim resists fire until they have already wasted Embers on it.

---

## 13. Living World (Phase 5 constraint, recorded now)

**The world persists and evolves whether or not any given player is online.** This is a requirement, not a nice-to-have, and it constrains architecture from Phase 2 onward:

- **World state is server-owned and tick-driven.** It must never live in a player session. A `WorldEvent` (§9) starts, runs and ends on the server's clock; logging in reads the world's current state rather than starting it.
- **Nothing about the world may be lazily evaluated on player action.** "The invasion begins when someone walks in" is the failure mode to avoid — it makes the world a story tree with extra steps.
- **Offline consequences are legitimate.** Events can resolve, prices can move, and zones can change control while a player is away. What must *never* change while they are away is their character's mortality: a character cannot die offline.
- Phase 2's schema already carries `world_events` for this. Phase 5 adds the tick loop, and the tick loop is the feature.

Post-hub, the game is deliberately conventional — **shared world, shared dungeons, shared progression, standard MMO structure.** All of the bespoke, per-player authored content is spent in front of the First Camp (§5.1). That is the trade: distinctive openings, conventional and schedulable everything-else.

### 13.1 The world tick — a self-sustaining engine

Yes, this is buildable, and it is not exotic. It is one loop, one table, and a discipline about where state lives.

**The shape:**

```
                    ┌──────────────────────────────┐
   every N seconds  │        WORLD TICK            │
   ────────────────▶│  (one process, server-owned) │
                    └──────────────┬───────────────┘
                                   │ reads + writes
                    ┌──────────────▼───────────────┐
                    │   world_state (Postgres)     │
                    │   events · prices · control  │
                    └──────────────┬───────────────┘
       players read it ────────────┘
       players never own it
```

**The rule that makes it work:** the tick may write world state and read player state. It may **never** write player state. That single constraint is what keeps a character from dying, levelling, or losing items while its owner is asleep — and it is what stops the tick from racing player commands.

**A tick does four things, in order:**
1. **Advance clocks.** Timed events expire, spawn timers count down, market prices drift.
2. **Resolve pressure.** Each zone carries a numeric `pressure` that rises on its own and falls when players clear content. Cross a threshold and the tick opens a `WorldEvent` — an invasion, a flooding, a closed road.
3. **Emit.** Anything that changed is written to `world_events` and pushed over Socket.io to whoever is connected. Nobody has to be connected for step 2 to have happened.
4. **Persist.** One transaction per tick. A crashed tick is a skipped tick, never a half-applied one.

**Catch-up on restart is the part people get wrong.** The tick must be a pure function of elapsed time, not of how many times it ran. Store `last_tick_at`; on boot, compute how many ticks were missed and either fast-forward them or apply a closed-form result. If a two-hour outage produces a different world than two hours of uptime, the loop is wrong.

**Cadence:** one tick every 30–60 seconds is plenty for a text MMO — the world should feel like weather, not like a strobe. Long events (a three-day siege) are just state with an `ends_at`, not a loop that runs for three days.

**Cost of the whole thing:** a `setInterval`, a `world_state` table, and about 200 lines. The engineering is trivial. The discipline — *never let a player action be the thing that advances the world* — is the entire feature.

**Sequencing against the roadmap:** the tick belongs in Phase 5, but it must not be *retrofitted*. Phase 2 lands the `world_events` table (already in §9) and the `last_tick_at` row; Phase 3 has the hub read world state rather than compute it. Then Phase 5 is switching the loop on, not rebuilding for it.
