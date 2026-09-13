# PROGRESS.md

Original prompt: Build a D&D-style text-based MMORPG in the browser. Character creation (class + background), server-authoritative virtual dice with unlockable skins plus an optional manual/physical-dice mode, hardcore permadeath until the first dungeon boss is beaten, beating that boss unlocks a persistent social hub/city (chat, party invites, dungeon grouping), and a living world that persists and evolves rather than a static story tree. Stack: Node.js + Express, Socket.io, PostgreSQL, plain HTML/CSS/JS front end. Phased roadmap Phase 0 (design doc) through Phase 8 (launch). Immediate next step: write GAME_DESIGN.md.

**Later direction from the user, in order given:**
1. Living world — life continues while players are offline.
2. Each character gets a unique story up to a **first camp** before the dungeon; the dungeon exit is a **portal** into the social hub; everything after the hub is conventional MMO structure.
3. A real character-creation screen with **character models**, **actually animated dice**, and a **hub UI with a character frame**. Immersive.
4. **No class-locked characters.** "Class" is derived from **weapon × background** — staff + gutter rat is a dark/gutter mage.
5. **Infinite classes** from that product, and **more backgrounds**.

---

## Status

**Phase 0 complete. Phase 1 complete and verified.**

| Phase | State |
|---|---|
| 0 — Design document | ✅ [GAME_DESIGN.md](GAME_DESIGN.md) |
| 1 — Core single-player loop | ✅ Playable end to end, 99 tests green |
| 2 — Persistence & accounts | ⬜ Not started |
| 3 — Social hub / city | ⬜ Shell UI only (clearly labelled) |
| 4 — Group dungeons | ⬜ Not started |
| 5 — Living world | ⬜ Designed (§13.1), not built |
| 6 — Dice customisation | ⬜ Schema supports it; no UI |
| 7 — Content scaling | ⬜ Content is data, ready to grow |
| 8 — Polish & launch | ⬜ Not started |

Run it:

```bash
npm --prefix C:\Users\DaiHa\Documents\TextMMO start
```

Test it:

```bash
npm --prefix C:\Users\DaiHa\Documents\TextMMO test
```

---

## What exists

```
server/
  dice.js        server-authoritative RNG, RollResult, advantage, crit, formatting
  rules.js       pure derived-stat maths (mods, proficiency, XP, AC, HP)
  content.js     content loader + title generator + prologue routing
  character.js   character construction, inventory, levelling, death
  combat.js      initiative, actions, abilities, Maugrim's three phases
  game.js        session, rooms, commands, permadeath, victory
  parser.js      verb-first grammar with did-you-mean
  index.js       Express API (no DB, no sockets — that is Phase 2/3)
  content/       abilities · weapons · backgrounds · items · enemies · rooms  (all JSON)
public/
  index.html     three screens: creation, game, hub
  style.css      lamplight-on-wet-paper terminal
  app.js         renders and animates; contains no game logic
  portraits.js   procedural SVG character models, set against a public-domain Piranesi crypt engraving
  dice.js        tumbling dice that settle on the server's result
  audio.js       CC0/public-domain looping ambience plus small synthesized interface cues
  assets/        public-domain visual art and its source record
  audio/         CC0/public-domain ambience recordings and their source record
test/            99 tests — dice, rules, parser, and end-to-end game chains
```

---

## The character system (this changed twice — read this before touching it)

**There are no classes.** A character is:

- a **weapon** — the mechanics: hit die, armour, scaling ability, resource, and which abilities you learn
- a **background** — the story: +1 ability, a skill, a starting item, a hub hook, and **your prologue**

The pair generates a **title**, and both halves contribute abilities, so a pair is a genuinely distinct class rather than a renamed one:

- **Weapon track** — 3 *active* combat abilities at levels 1/2/3
- **Background track** — 2 *passive/world* abilities at levels 1/2, each addressed by an engine `hook`

**Shipped grid is deliberately scoped** (§3.3): 4 of the 10 backgrounds are selectable, so **10 × 4 − 4 prohibitions = 36 playable kits** today. All 10 backgrounds stay authored — 89 kits are written and waiting — and the other 6 are held behind a `"locked": true` flag in `backgrounds.json`.

Locked, never deleted. Locked backgrounds are rejected **server-side** at creation (`character.js`), their titles are withheld from the client catalogue, and they render on the creation screen dimmed and dashed as *a later chapter*. A test asserts each one is still complete enough to unlock with a single flag flip.

**Titles are hand-written, all 100 of them** (§3.2, `server/content/titles.json`). The prefix+noun generator that came first was replaced: it produced 90 names that read as 10 families — every Gutter Rat was Gutter-something — so the background swallowed the identity. `staff + gutter_rat` is now **Trickster**, not Gutter Mage. Two tests guard the regression: no shared first word within a background, no shared last word within a weapon. A missing title throws rather than falling back to generation, deliberately.

- **Abilities are a shared pool** (`content/abilities.json`). Weapons reference them by id. **Adding a weapon therefore costs zero engine code** — only a genuinely new ability needs work in `combat.js`.
- Portraits are driven by `weapon.figure` (`armoured` / `hooded` / `robed` / `lantern` / `shrouded`) plus a per-background accessory, so new weapons reuse a silhouette.

**To add a weapon:** one entry in `weapons.json` (set `figure` and 3 ability ids), **plus one written title + gloss per playable background** in `titles.json` — 4 today, not 10, which is the point of §3.3.
**To add a background:** one entry in `backgrounds.json` (2 ability ids + optional `forbids`), two prologue rooms in `rooms.json`, one accent in `portraits.js`, and 9 titles in `titles.json`.

**To unlock a held-back background:** delete its `"locked": true` line. That is the whole job — prologue, abilities, hub hook and all nine titles are already written and test-covered.

**Background abilities are addressed by `hook`, never by background id.** Reusing an existing hook costs zero engine code; a genuinely new hook is one small edit in `combat.js` or `game.js`. There is a test that fails if any declared hook is never read by the engine — a hook nobody consults is an ability the player was promised and does not have.

**Prohibitions** (`forbids` in `backgrounds.json`) are a short forbidden list, deliberately not an allow-list. A test asserts more than 80% of pairs stay legal; if you add restrictions past that, the rule has stopped paying for itself.

---

## World shape

```
creation → background prologue (2 rooms, always DOWN) → The Descent (shared)
        → THE FIRST CAMP (free rest, convergence)
        → Sunken Warrens (6 nodes) → Maugrim → ◆ PORTAL ◆ → Ashvault
                                        └────→ DOWN → The Hollow Crypt (optional)
                                                       branch W or E, W=Wisps
                                                       E = the Rift (one way)
                                                       → The Withered Warden
```

**Maugrim now opens two exits**: the portal to Ashvault, or down into the Crypt. Take the win or push. The Crypt grants no hub access — only the gate boss does — and its boss drops the game's first **Epic** items, which is what makes the rarity curve matter.

Everything before the camp is authored per background. Everything after is shared — which is what makes it schedulable as group content later.

---

## Balance: measured, not guessed

The spec's original numbers gave a **0% clear rate over 800 simulated runs** — they were party-scaled and Phase 1 is solo. Full record and reasoning in GAME_DESIGN §12a. Current clear rates with competent play: roughly **Blade-style 63% / bow 31% / lantern 26% / staff 14%**.

**Do not re-tune from intuition.** There is a simulation harness pattern in the git history of this file: instantiate `GameSession` directly, drive it with a bot, run 300× per weapon, read the death-room histogram. Every number in `enemies.json` and the two HP allowances in `rules.js` was set that way.

**Re-measured 2026-09-12** with a fresh bot in `tools/simulate.mjs` (the older harness was never committed). 300 runs each: longsword 51 · **gravebell 40** · warhammer 37 · lantern 25 · longbow 18 · staff 9. These are not comparable to the figures below — different bot, weaker play — but they are comparable *to each other*.

**A warning worth reading before you trust any of these.** Tuning the Grave-Bell, three consecutive buffs produced no movement at all because **the simulation bot was broken**, not the balance: it gated Raise Thrall on a dead enemy, so it never used the opening body. The weapon read as 1% for six iterations and was actually fine. Before changing a single number in `enemies.json`, check that the bot can actually play the thing you are measuring.

The staff line is **on the edge of acceptable at 14%** and should be watched. A third of its gap was a *teaching* problem, not a numbers problem: Maugrim resists fire from phase 2, and nothing warns the player before they have burned Embers on it.

---

## 2026-09-12 — Dark Glory merge, first pass

The user supplied `DarkGlorydesign.md` (in Downloads) as an overhaul. It is a **from-scratch Phase 0 bible**, not a patch, so it is silent on a lot that already exists. Full 66-point comparison lives in `delta.html` and is published as an artifact. Headline: 22 agrees, 18 differs, 10 conflicts, 8 adds, 8 silent.

**Decided and built (solo-safe subset only, by the user's instruction):**

1. **The Necromancer, as the Grave-Bell weapon** (§2.10). CHA/d6/Vitae — the only CHA weapon, which closes the last empty column in the stat table.
   - **Raise Thrall replaces the doc's Raise Zombie at level 1.** The doc's version targets a Downed *ally*, which is inert in solo play — the class would have had no signature ability from level 1 to 3. Raise Thrall raises the *enemy* you just killed instead. Same fantasy, works alone, works better in a party. Raise Zombie returns at level 4 in Phase 4.
   - The Thrall takes a real slot in the initiative order (`kind: 'thrall'`), and **every enemy retargets onto it while it stands**. It is a meat shield, not a damage pet — that is the whole bargain of the weapon and the only reason an AC 10 d6 caster survives the Cistern.
   - New portrait figure `shrouded`, and it is the only figure with a second silhouette in the frame: the Thrall is the class, so it is in the picture.
2. **Rarity is now a power curve** (§6b), +0/+1/+2/+3 to attack and damage. It previously did *nothing* but set a bank fee. Weapons only — defensive items carry their tier in their own `ac`, and a test guards against double-counting.
3. **Flee DC comes from the enemy** (`fleeDc` in `enemies.json`), hardest living enemy sets it, flat 12 is the floor.
4. **Sound** (§6c) — `public/audio.js`. The score now uses real CC0/public-domain music from OpenGameArt (listed in `public/audio/ASSET_SOURCES.md`): bell-and-pad exploration, a mournful rest theme, and a composed boss track. This replaces the original drone-heavy/buzzy ambience. Small interface cues remain synthesized; M toggles all sound and the choice persists.

**A real bug this surfaced:** `playerAbility` spent the resource *before* the per-ability validation ran, so any ability refused after that point (no target, no body to raise) silently ate a charge. Cinderbolt with no target had been doing this all along. The spend now happens inside `consume()`, at the moment the ability commits.

**Deliberately NOT built** — every one of these needs other players, and lands in Phase 3/4: the Downed state and 10-minute revival window, Cleric/Necromancer revival, contested revival, the Zombie fork, corpse looting, and the Rift Room. Solo, a revival timer nobody can answer is strictly worse than instant death.

**Also rejected, with reasons in the delta:** rolling stats in fixed order (removes the only decision before dying), one action per turn (breaks every bonus-action ability), and the doc's 5/15/40/100 bank fees (our economy is in the hundreds; that is free).

## TODO — next agent

## 2026-09-12 — melodic score pass

- Replaced the ambience-first default with a melodic dark-fantasy palette: **Somnium** for prologue/camp/hub, **Cathedral in the Forest** (pads and bells) for descent/warrens, and **Boss Fight** for boss rooms. All three are CC0 and need no attribution; sources are recorded in `public/audio/ASSET_SOURCES.md`.
- Reduced music volume from 0.34 to 0.27 so narration and dice cues remain foregrounded.
- `npm test`: **99 passing**.
- The web-game skill's referenced Playwright helper and action-payload file are absent from this plugin install; browser verification used the live localhost build instead.

## 2026-09-12 — online account foundation and mobile portrait pass

- Added account infrastructure with signed HttpOnly cookies and a persistent one-run-per-account save model. It was subsequently changed to passwordless Vault Keys below.
- Added `PostgresStore` (used when `DATABASE_URL` is set) and an in-memory development store for local play. `GameSession.restore()` rehydrates a saved run, including an encounter in progress.
- Added the account screen and mobile portrait layout: one column, bottom command field, 16px phone input, safe-area padding, and a scrollable sheet below the narrative.
- Added `render.yaml`, `.env.example`, `DEPLOY.md`, and `/health` for a Render-backed itch.io playtest.
- Live local registration and sign-in tested successfully; `npm test`: **99 passing**.
- Music is now opt-in/silent by default. The old browser tab must be refreshed after the server replacement because it has the prior audio already loaded.

## 2026-09-12 — passwordless account decision

- Passwords have been removed. Account creation now mints a **shareable Friend Code** (`ASH-XXXX-XXXX`) for future party invites and a private **Vault Key** (`VAULT-XXXX-XXXX-XXXX`) for restoring the account on another device.
- The browser maintains a signed session after creation; the Vault Key is shown once and must be saved. This keeps party codes safe to share while preserving passwordless recovery.
- Opening `public/index.html` directly now gives a clear instruction to use `http://localhost:3000`; direct file pages cannot reach the Node game server.
- Friend Codes are shown again on the character sheet and in the hub, not only on the initial Vault Key screen.
- Added `RUN_ASHVAULT.cmd` so local players can start the server and open the correct address without accidentally opening the HTML file directly.
- Verified the full browser path: create account -> save key screen -> character creation. `npm test`: **100 passing**.

1. **Phase 2: persistence.** Accounts, Postgres, the §9 schema. The in-memory objects were shaped to match the tables, so this should be a swap rather than a rewrite. Enforce invariant §9.1.4 (one living character per account) here — it cannot be enforced in Phase 1 because there is no login.
2. Land `world_events` and a `last_tick_at` row in Phase 2 even though nothing reads them yet. §13.1 explains why retrofitting the world tick later is the failure mode.
3. **Phase 3: the hub.** The UI shell exists in `index.html` (`#hub`) with chat, players, vault and party panels all marked with their phase. Replace the panels; the character frame and portrait are already real.

**Gotchas**

- **The server caches content at import.** Editing anything in `server/content/` requires a server restart, not just a browser reload. This cost time twice.
- **Do not `sed` UTF-8 content files through PowerShell.** `Get-Content`/`Set-Content` round-tripping mangled every em-dash in `rooms.json`. Use the editor tools or `node -e`.
- `render_game_to_text()` and `__submitCommand()` are exposed on `window` for automated testing — this is a DOM game, so there is no `advanceTime` and no canvas.
- Boss-room tests must inflate HP first (`enterBossRoom`); Maugrim can otherwise end the fight during setup and make the test flaky.
- The Blade's **Riposte fires automatically** during enemy turns, so any test reading enemy HP right after an encounter starts should use a weapon without an auto-reaction.
- Weapons deliberately share abilities. If two weapons feel too alike, differentiate via damage die, armour, and scaling ability before writing a new ability.

**Open design questions** — GAME_DESIGN §11 (group loot, party wipe, tradeable marks, dice monetisation, guilds), each with the phase it must be answered by.

## 2026-09-13 — natural-language command pass

- Added a safe, local intent layer: `INVESTIGATE`, `ROLL CHECK`, `ROLL A PERCEPTION CHECK`, `MAKE AN INVESTIGATION CHECK`, and common search requests now resolve to `SEARCH`.
- This is deliberately not an external AI API. It is immediate, private, free to run, and only maps requests to the existing safe search interaction; it does not invent combat targets or outcomes.
- Updated the in-game command hint and `HELP` text. `npm test`: **101 passing**.
- Published as Git commit `d868f89` and manually deployed successfully to `https://ashvault.onrender.com`.

## 2026-09-13 — terminal input visibility fix

- Constrained the narrative log to its own scroll area (`min-height: 0`) and prevented the terminal from overflowing. The command bar now stays pinned when the story reaches the bottom of the screen, including portrait layouts.
- `npm test`: **101 passing**. Published as `b4568eb` and manually deployed successfully.

## 2026-09-13 — Pocket Save safety net

- Added an automatic browser-side backup after character creation and every resolved command. It contains the full resumable run, including room state, inventory, character, encounter and recent log.
- Added **Pocket Save** in the character sheet plus **Restore a Pocket Save** on the account screen. Codes are gzip-compressed, checksum-protected, copyable on mobile, and can recreate a fresh lightweight-server account before importing the saved run.
- This deliberately remains an honor-system backup. It protects itch.io playtests from browser clearing and Render memory restarts; future party, rankings and economy systems must use persistent server storage instead.
- Browser-tested end to end: created Pocket Runner, generated a code, restored it, and returned to the same character and room. `npm test`: **102 passing**.

## 2026-09-13 — bidirectional pairing lockout

- Fixed the creation-picker bug where a forbidden combination was only dimmed after choosing a background, and could still be clicked.
- Prohibitions now lock both halves of a pair: choosing the **Spear** disables **Gutter Rat**; choosing **Gutter Rat** disables **Spear**. Every other authored refusal behaves the same way, with its in-fiction reason retained as the control description.
- The server has always rejected those pairs; this makes the UI match the game rules. `npm test`: **102 passing**.
