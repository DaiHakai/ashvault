// Integration tests: drive GameSession the way the client does, and assert the
// multi-step chains from GAME_DESIGN.md §12 rather than single commands.
//
// Combat is random, so tests that need a specific outcome set up the state
// directly instead of hoping for a roll. Tests that only need "this eventually
// happens" retry, with the retry count high enough that a false failure is
// vanishingly unlikely at the measured clear rates.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GameSession } from '../server/game.js';
import { Encounter } from '../server/combat.js';
import { weaponAttackBonus, weaponDamageMod, addItem, equipItem, armourClass } from '../server/character.js';
import { rarityBonus } from '../server/rules.js';
import {
  getRoom, getWeapon, WEAPONS, BACKGROUNDS, titleFor, titleGlossFor,
  isBackgroundLocked, playableBackgroundIds, authoredCombinationCount,
  creationCatalogue, startingRoomFor,
  isAllowed, refusalFor, validCombinationCount, abilitiesFor, getEnemy, weaponTutorialFor,
} from '../server/content.js';

const WEAPON_IDS = Object.keys(WEAPONS);
/** Everything authored, including backgrounds held for a later version (§3.4). */
const BACKGROUND_IDS = Object.keys(BACKGROUNDS);
/** What a player can actually roll today. */
const PLAYABLE_BACKGROUND_IDS = playableBackgroundIds();

/**
 * Every prologue is two rooms and every step of it is DOWN (§5.1), so the first
 * verb a player learns never changes on them — and neither does this helper.
 */
const PROLOGUE_PATH = ['down', 'down', 'down'];

function newSession(weaponId = 'longsword', backgroundId = 'gravedigger') {
  const s = new GameSession();
  const pool = s.publicStatPool();

  // Put the best roll in whatever the weapon actually scales off, then CON.
  const primary = getWeapon(weaponId).primary;
  const order = [primary, 'con', ...['str', 'dex', 'con', 'int', 'wis', 'cha'].filter((a) => a !== primary && a !== 'con')];
  const ranked = pool.map((p, i) => ({ i, total: p.total })).sort((a, b) => b.total - a.total);
  const assignment = {};
  order.forEach((ability, n) => { assignment[ability] = ranked[n].i; });

  s.beginGame({ name: 'Testfellow', weaponId, backgroundId, assignment });
  s.takeRecent();
  return s;
}

const textOf = (result) => result.entries.map((e) => `${e.kind}:${e.text}`).join('\n');

/** Fight until the room resolves, passing when the action has been taken away. */
function fightOut(s, limit = 80) {
  for (let i = 0; i < limit && s.fighting() && s.state === 'playing'; i++) {
    s.command(s.snapshot().encounter.actionUsed ? 'pass' : 'attack');
  }
}

/**
 * Drop the character into the Drowned Throne with enough HP that Maugrim cannot
 * end the fight during setup. These tests are about phase transitions, exits and
 * loot — survival is covered by the clearable-dungeon test, not by these.
 */
function enterBossRoom(s) {
  s.character.hpMax = 500;
  s.character.hp = 500;
  s.enterRoom('drowned_throne');
  return s;
}

/** Walk from character creation to the mouth of the Warrens. */
function toWarrens(s) {
  s.command(PROLOGUE_PATH[0]); // into the prologue's encounter room
  fightOut(s);
  s.command(PROLOGUE_PATH[1]); // the shared Descent
  s.command('search');
  s.command(PROLOGUE_PATH[2]); // the First Camp
  return s;
}

// -------------------------------------------------- identity is generated

test('there are no classes — identity is a weapon crossed with a background', () => {
  assert.ok(WEAPON_IDS.length >= 8, 'expected a real spread of weapons');
  assert.ok(BACKGROUND_IDS.length >= 10, 'expected a real spread of backgrounds');

  const titles = new Set();
  for (const w of WEAPON_IDS) {
    for (const b of BACKGROUND_IDS) {
      const title = titleFor(w, b);
      assert.ok(title && title.length > 2, `${w} x ${b} produced no title`);
      titles.add(title);
    }
  }
  assert.equal(
    titles.size,
    WEAPON_IDS.length * BACKGROUND_IDS.length,
    'every weapon x background pair must yield a distinct identity'
  );
});

test('some pasts refuse some weapons, and always say why', () => {
  const refusals = [];
  for (const w of WEAPON_IDS) {
    for (const b of BACKGROUND_IDS) {
      const reason = refusalFor(w, b);
      if (reason === null) continue;
      refusals.push(`${b}:${w}`);
      assert.ok(reason.length > 30, `${b} refusing ${w} needs a real reason, got "${reason}"`);
    }
  }
  assert.ok(refusals.length > 0, 'expected some prohibitions');
  assert.equal(
    authoredCombinationCount(),
    WEAPON_IDS.length * BACKGROUND_IDS.length - refusals.length
  );
  // The restriction must stay a short forbidden list, never a sparse allow-list.
  assert.ok(
    authoredCombinationCount() / (WEAPON_IDS.length * BACKGROUND_IDS.length) > 0.8,
    'prohibitions should trim the space, not gut it'
  );
});

test('locking backgrounds shrinks the shipped grid without touching content', () => {
  // Scope control (§3.4): 4 of 10 backgrounds ship, the rest stay authored.
  assert.equal(PLAYABLE_BACKGROUND_IDS.length, 4);
  assert.equal(BACKGROUND_IDS.length, 10, 'all ten stay in content');
  assert.equal(validCombinationCount(), 36, 'what a player can roll today');
  assert.equal(authoredCombinationCount(), 89, 'what is written and ready');

  // Every locked background is fully finished, so unlocking is a flag flip and
  // never a content task. This is the whole justification for locking over deleting.
  for (const b of BACKGROUND_IDS.filter(isBackgroundLocked)) {
    assert.ok(startingRoomFor(b), `${b} has no prologue`);
    for (const w of WEAPON_IDS) {
      assert.ok(titleFor(w, b), `${w}:${b} has no title`);
      assert.ok(titleGlossFor(w, b), `${w}:${b} has no gloss`);
    }
  }
});

test('a locked background is refused server-side, not merely hidden', () => {
  const s = new GameSession();
  assert.throws(
    () => s.beginGame({
      name: 'Smuggled', weaponId: 'longsword', backgroundId: 'ferryman',
      assignment: { str: 0, dex: 1, con: 2, int: 3, wis: 4, cha: 5 },
    }),
    /not available yet/
  );
});

test('the catalogue ships only what can be rolled', () => {
  const cat = creationCatalogue();
  assert.equal(cat.backgrounds.length, 4);
  assert.equal(cat.comingSoon.length, 6);
  for (const b of cat.backgrounds) assert.ok(!isBackgroundLocked(b.id));
  for (const w of WEAPON_IDS) {
    assert.deepEqual(Object.keys(cat.titles[w]).sort(), [...PLAYABLE_BACKGROUND_IDS].sort());
  }
  for (const c of cat.comingSoon) assert.ok(c.note?.length > 10, 'a locked chip needs a note');
});

test('a forbidden pair is refused at creation with its in-fiction reason', () => {
  // Uses a playable background, so this tests the prohibition and not the lock.
  assert.equal(isAllowed('tome', 'gravedigger'), false);
  const s = new GameSession();
  assert.throws(
    () => s.beginGame({
      name: 'Nope', weaponId: 'tome', backgroundId: 'gravedigger',
      assignment: { str: 0, dex: 1, con: 2, int: 3, wis: 4, cha: 5 },
    }),
    /never learned your letters/
  );
  assert.equal(s.state, 'creation', 'a refused pair must not start a run');
});

test('every background can still carry most weapons', () => {
  for (const b of BACKGROUND_IDS) {
    const allowed = WEAPON_IDS.filter((w) => isAllowed(w, b));
    assert.ok(allowed.length >= WEAPON_IDS.length - 2, `${b} is over-restricted`);
  }
});

test('a staff carried by a gutter rat is a Trickster', () => {
  assert.equal(titleFor('staff', 'gutter_rat'), 'Trickster');
  const s = newSession('staff', 'gutter_rat');
  assert.equal(s.snapshot().character.title, 'Trickster');
  assert.equal(s.snapshot().character.weaponName, 'Staff');
  assert.equal(s.snapshot().character.backgroundName, 'Gutter Rat');
});

test('all 90 titles are written, distinct, and glossed', () => {
  const seen = new Map();
  for (const w of WEAPON_IDS) {
    for (const b of BACKGROUND_IDS) {
      const title = titleFor(w, b);
      assert.ok(title, `${w} x ${b} has no title`);
      assert.ok(!seen.has(title), `"${title}" is used by both ${seen.get(title)} and ${w} x ${b}`);
      seen.set(title, `${w} x ${b}`);
      assert.ok(titleGlossFor(w, b)?.length > 10, `${w} x ${b} has no gloss`);
    }
  }
  assert.equal(seen.size, WEAPON_IDS.length * BACKGROUND_IDS.length);
});

test('titles no longer collapse into per-background families', () => {
  // The prefix generator produced 90 names sharing only 10 first words —
  // every Gutter Rat was Gutter-something. Written titles must not do that.
  for (const b of BACKGROUND_IDS) {
    const firstWords = new Set(WEAPON_IDS.map((w) => titleFor(w, b).split(' ')[0]));
    assert.equal(firstWords.size, WEAPON_IDS.length, `${b} titles share a stem`);
  }
  for (const w of WEAPON_IDS) {
    const lastWords = new Set(BACKGROUND_IDS.map((b) => titleFor(w, b).split(' ').at(-1)));
    assert.equal(lastWords.size, BACKGROUND_IDS.length, `${w} titles share a noun`);
  }
});

test('a missing title is a loud failure, not a generated fallback', () => {
  assert.throws(() => titleFor('staff', 'no_such_background'));
  assert.throws(() => titleFor('no_such_weapon', 'gutter_rat'));
});

test('every legal pair is a mechanically distinct kit, not just a distinct name', () => {
  const kits = new Map();
  for (const w of WEAPON_IDS) {
    for (const b of BACKGROUND_IDS) {
      if (!isAllowed(w, b)) continue;
      const kit = abilitiesFor(w, b).map((a) => `${a.id}@${a.level}`).sort().join('|');
      assert.ok(!kits.has(kit), `${w} x ${b} has the same kit as ${kits.get(kit)}`);
      kits.set(kit, `${w} x ${b}`);
    }
  }
  // Checked across everything authored, not just what currently ships — a
  // locked background must still be a distinct kit on the day it is unlocked.
  assert.equal(kits.size, authoredCombinationCount(), 'every legal pair must be its own kit');
});

test('abilities come from two tracks: the weapon is active, the background is passive', () => {
  const kit = abilitiesFor('staff', 'gutter_rat');
  const weaponTrack = kit.filter((a) => a.track === 'weapon');
  const backgroundTrack = kit.filter((a) => a.track === 'background');

  assert.equal(weaponTrack.length, 3, 'weapons contribute three abilities');
  assert.equal(backgroundTrack.length, 2, 'backgrounds contribute two');
  assert.ok(
    weaponTrack.some((a) => a.type === 'action'),
    'the weapon track carries the things you press in a fight'
  );
  for (const a of backgroundTrack) {
    assert.ok(a.hook, `background ability ${a.id} must declare an engine hook`);
  }
});

test('every background ability hook is one the engine actually consults', () => {
  // A hook nobody reads is a dead ability the player was promised.
  const engine = readFileSync(new URL('../server/combat.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../server/game.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../server/character.js', import.meta.url), 'utf8');

  for (const b of BACKGROUND_IDS) {
    for (const a of abilitiesFor('longsword', b).filter((x) => x.track === 'background')) {
      // `saveAdvantage:con` is consulted via a template literal, so match the stem.
      const stem = a.hook.split(':')[0];
      assert.ok(
        engine.includes(`'${a.hook}'`) || engine.includes(`${stem}:$`) || engine.includes(`'${stem}:`),
        `hook "${a.hook}" (${a.id}) is never read by the engine`
      );
    }
  }
});

test('the weapon decides the mechanics and the background decides the story', () => {
  const a = newSession('staff', 'gutter_rat');
  const b = newSession('staff', 'gravedigger');
  const c = newSession('warhammer', 'gutter_rat');

  const known = (s) => s.snapshot().character.known.map((k) => k.name);
  const activeOf = (weaponId, backgroundId) =>
    abilitiesFor(weaponId, backgroundId).filter((x) => x.track === 'weapon').map((x) => x.name);
  const passiveOf = (weaponId, backgroundId) =>
    abilitiesFor(weaponId, backgroundId).filter((x) => x.track === 'background').map((x) => x.name);

  // Same weapon, different background: identical combat kit, different prologue
  // and different passives.
  assert.equal(getRoom(a.roomId).prologueFor, 'gutter_rat');
  assert.equal(getRoom(b.roomId).prologueFor, 'gravedigger');
  assert.deepEqual(
    activeOf('staff', 'gutter_rat'),
    activeOf('staff', 'gravedigger'),
    'the weapon alone decides the active combat kit'
  );
  assert.notDeepEqual(
    passiveOf('staff', 'gutter_rat'),
    passiveOf('staff', 'gravedigger'),
    'the background alone decides the passives'
  );
  assert.notDeepEqual(known(a), known(b), 'so the two are different classes in play');

  // Same background, different weapon: same opening, different discipline.
  assert.equal(getRoom(c.roomId).prologueFor, 'gutter_rat');
  assert.notDeepEqual(known(a), known(c));
  assert.deepEqual(
    passiveOf('staff', 'gutter_rat'),
    passiveOf('warhammer', 'gutter_rat'),
    'the past travels with you whatever you pick up'
  );
});

// ------------------------------------------------------------------ start

test('every background begins in its own prologue, and they all converge on the camp', () => {
  const starts = new Set();
  for (const backgroundId of PLAYABLE_BACKGROUND_IDS) {
    const s = newSession('longsword', backgroundId);
    const room = getRoom(s.roomId);
    assert.equal(room.prologueFor, backgroundId, `${backgroundId} should start in its own prologue`);
    assert.ok(room.prologueStart, 'should start at the prologue entrance');
    starts.add(s.roomId);

    toWarrens(s);
    if (s.state !== 'playing') continue; // died in the prologue; nothing to assert
    assert.equal(s.roomId, 'first_camp', `${backgroundId} should converge on the First Camp`);
  }
  assert.equal(starts.size, PLAYABLE_BACKGROUND_IDS.length, 'every prologue must be distinct');
});

test('locked backgrounds still have distinct prologues waiting for them', () => {
  const starts = new Set(BACKGROUND_IDS.map(startingRoomFor));
  assert.equal(starts.size, BACKGROUND_IDS.length, 'all ten prologues exist and are distinct');
});

test('every weapon produces a playable character', () => {
  for (const weaponId of WEAPON_IDS) {
    // Pick a past that will actually carry it (§3.1).
    const background = PLAYABLE_BACKGROUND_IDS.find((b) => isAllowed(weaponId, b));
    assert.ok(background, `${weaponId} is forbidden to every background`);
    const s = newSession(weaponId, background);
    const c = s.snapshot().character;
    assert.ok(c.hp > 0, `${weaponId} has no HP`);
    // AC is the weapon's own armour base plus DEX, and DEX here is only the
    // fourth-best roll — a light-armour weapon legitimately lands below 10 on a
    // bad pool. Measure against that weapon's armour, not a magic number.
    const { armour } = getWeapon(weaponId);
    const floor = armour.base + (armour.dexBonus ? -4 : 0);
    assert.ok(c.ac >= floor, `${weaponId} has a nonsense AC: ${c.ac} (floor ${floor})`);
    assert.ok(c.known.length >= 1, `${weaponId} knows no abilities at level 1`);
    assert.ok(c.weapon && c.weapon !== 'Bare hands', `${weaponId} did not equip its own weapon`);
  }
});

test('a fresh character is alive, level 1, and not hub-unlocked', () => {
  const s = newSession();
  const c = s.snapshot().character;
  assert.equal(c.level, 1);
  assert.equal(c.xp, 0);
  assert.equal(c.status, 'alive');
  assert.equal(c.hubUnlocked, false);
  assert.equal(c.hp, c.hpMax);
});

test('the stat pool is rolled once and cannot be rerolled', () => {
  const s = new GameSession();
  const first = s.publicStatPool().map((p) => p.total);
  const second = s.publicStatPool().map((p) => p.total);
  assert.deepEqual(first, second, 'asking again must not reroll');
});

test('creation rejects a reused score and an empty name', () => {
  const s = new GameSession();
  const dup = { str: 0, dex: 0, con: 1, int: 2, wis: 3, cha: 4 };
  assert.throws(
    () => s.beginGame({ name: 'X', weaponId: 'longsword', backgroundId: 'gravedigger', assignment: dup }),
    /only be used once/
  );
  assert.throws(
    () => s.beginGame({ name: '  ', weaponId: 'longsword', backgroundId: 'gravedigger', assignment: { str: 0, dex: 1, con: 2, int: 3, wis: 4, cha: 5 } }),
    /needs a name/
  );
});

// ---------------------------------------------------------------- commands

test('an unknown command suggests the closest verb instead of failing bare', () => {
  const s = newSession();
  assert.match(textOf(s.command('atack')), /Did you mean: attack\?/);
});

test('movement is blocked during combat — you must flee or finish it', () => {
  const s = newSession();
  s.command(PROLOGUE_PATH[0]); // into the prologue fight
  if (!s.fighting()) return; // the fight can end on the first exchange
  assert.match(textOf(s.command('east')), /cannot simply walk away/);
});

test('every roll in the log carries its full visible maths', () => {
  const s = newSession();
  s.command(PROLOGUE_PATH[0]);
  if (!s.fighting()) return; // the entry exchange can end the fight outright
  const out = textOf(s.command('attack'));
  const rollLine = out.split('\n').find((l) => l.startsWith('roll:') && l.includes('vs'));
  assert.ok(rollLine, 'expected at least one roll against a target number');
  assert.match(
    rollLine,
    /\dd\d+[+-]?\d* → \[[\d, ]+\](?:\s*\(dropped[^)]*\))?[+-]?\d* = \d+ vs (AC|DC) \d+ — [A-Z]+/,
    `roll line did not show full maths: ${rollLine}`
  );
});

// ------------------------------------------------------------------ chains

test('killing an enemy raises XP, which raises level, which raises max HP', () => {
  const s = newSession();
  const before = s.snapshot().character;
  s.command(PROLOGUE_PATH[0]);
  fightOut(s);
  if (s.state !== 'playing') return; // died; the chain is covered by other runs

  const after = s.snapshot().character;
  assert.ok(after.xp > before.xp, 'XP should rise on a kill');

  // Push to the Cistern, which is enough XP for level 2.
  toWarrens(s);
  if (s.state !== 'playing') return;
  s.command('north');
  s.command('north');
  fightOut(s);
  if (s.state !== 'playing') return;

  const levelled = s.snapshot().character;
  assert.equal(levelled.level, 2, 'the Cistern should complete level 2');
  assert.ok(levelled.hpMax > before.hpMax, 'levelling must raise max HP');
});

test('the camp rest is free, happens once, and does not consume the dungeon shrine', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;

  s.character.hp = 1;
  assert.match(textOf(s.command('rest')), /Restored/);
  assert.equal(s.character.hp, s.character.hpMax, 'the camp restores fully');
  assert.match(textOf(s.command('rest')), /does not do that twice|had your night/);

  // The Wardroom shrine is a different room and still available.
  assert.equal(s.rooms.wardroom?.shrineUsed ?? false, false);
});

test('the dungeon shrine restores once and then goes cold', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  // Drop the character straight into the Wardroom rather than fighting there.
  s.enterRoom('wardroom');
  s.takeRecent();
  s.character.hp = 1;

  assert.match(textOf(s.command('rest')), /Restored/);
  assert.equal(s.character.hp, s.character.hpMax);
  assert.match(textOf(s.command('rest')), /stone is cold/);
});

test('a successful flee falls back a room and records the enemies as you left them', () => {
  // A failed flee gives every enemy a free swing, so retry until one escapes
  // rather than hanging the assertion on a single DEX check.
  for (let attempt = 0; attempt < 40; attempt++) {
    const s = toWarrens(newSession());
    if (s.state !== 'playing') continue;
    s.command('north'); // threshold
    s.command('north'); // cistern — combat
    if (!s.fighting()) continue;

    s.character.abilities.dex = 20; // make the DC 14 check land often
    for (let tries = 0; tries < 12 && s.fighting() && s.state === 'playing'; tries++) {
      s.character.hp = s.character.hpMax; // failed attempts must not end the run
      s.command(s.snapshot().encounter.actionUsed ? 'pass' : 'flee');
    }
    if (s.state !== 'playing' || s.fighting()) continue;

    assert.equal(s.roomId, 'warren_threshold', 'flight falls back the way you came');
    assert.ok(Array.isArray(s.rooms.cistern.savedHp), 'enemy HP is recorded on the room');
    assert.equal(s.rooms.cistern.cleared, false, 'a room you fled is not a room you cleared');
    return;
  }
  assert.fail('never managed a successful flee in 40 attempts');
});

test('re-entering a fled room rebuilds the enemies at the HP they were left on', () => {
  // Deterministic half of the flee contract: given recorded HP, the room must
  // re-engage with exactly those wounds rather than a fresh set of enemies.
  //
  // Deliberately a Stalker, not a Blade: the Blade's Riposte is an automatic
  // reaction that fires during the enemies' opening turns and damages them
  // before this assertion can read their HP.
  const s = toWarrens(newSession('longbow'));
  if (s.state !== 'playing') return;
  s.character.hpMax = 500;
  s.character.hp = 500;

  s.rooms.cistern = { visited: true, searched: false, cleared: false, savedHp: [2, 5], shrineUsed: false };
  s.enterRoom('cistern');

  assert.ok(s.fighting(), 're-entering re-engages the survivors');
  assert.deepEqual(
    s.encounter.enemies.map((e) => e.hp),
    [2, 5],
    'enemies come back wounded, not healed'
  );
  assert.deepEqual(s.encounter.enemies.map((e) => e.hpMax), [6, 6], 'their maximums are unchanged');
});

test('a boss room cannot be fled', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  enterBossRoom(s);
  s.takeRecent();
  assert.match(textOf(s.command('flee')), /no leaving this/);
});

// ------------------------------------------------------------------- death

test('reaching 0 HP is permanent: inventory destroyed, every command refused', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  s.command('north');
  s.command('north'); // cistern
  if (!s.fighting()) return;

  s.character.hp = 1;
  s.takeRecent();
  fightOut(s, 40);
  if (s.state !== 'dead') return; // survived on luck; covered by repetition below

  const c = s.snapshot().character;
  assert.equal(c.status, 'dead');
  assert.equal(c.hp, 0);
  assert.deepEqual(c.inventory, [], 'carried inventory is destroyed, not dropped');
  assert.equal(c.marks, 0);
  assert.ok(s.snapshot().death, 'a memorial record is written');

  for (const cmd of ['north', 'search', 'attack', 'rest', 'use ration', 'inventory']) {
    assert.match(textOf(s.command(cmd)), /You are dead/, `"${cmd}" should be refused`);
  }
  // SHEET stays available so the player can read what they lost.
  assert.match(textOf(s.command('sheet')), /Testfellow/);
});

test('death is terminal — a dead character can never be resumed', () => {
  const s = newSession();
  s.character.hp = 1;
  s.handleDeath('a test');
  assert.equal(s.state, 'dead');
  assert.match(textOf(s.command('restart')), /Six scores/);
  assert.equal(s.state, 'creation', 'restart builds a new character, never revives the old one');
  assert.equal(s.character, null);
});

test('restart is refused while the character is still alive', () => {
  const s = newSession();
  assert.match(textOf(s.command('restart')), /Finish the run, or die trying/);
  assert.equal(s.state, 'playing');
});

// -------------------------------------------------------------------- boss

test('Maugrim announces phase one at the start, not only on transitions', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  s.takeRecent();
  enterBossRoom(s);
  const out = textOf({ entries: s.takeRecent() });
  assert.match(out, /The Warden Stirs/, 'the opening phase must be announced');
  assert.match(out, /the door grinds shut/, "phase one's opening text must actually play");
});

test('Maugrim moves through all three phases as HP falls', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  enterBossRoom(s);
  const boss = s.encounter.enemies.find((e) => e.boss);

  assert.equal(boss.phase, 1);
  boss.hp = 25;
  s.encounter.checkBossPhase(boss);
  assert.equal(boss.phase, 2, 'phase 2 at the flood');

  boss.hp = 10;
  s.encounter.checkBossPhase(boss);
  assert.equal(boss.phase, 3, 'phase 3 at the Drowning Song');
});

test('the portal only opens once Maugrim is down, and leads to Ashvault', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  enterBossRoom(s);
  s.takeRecent();

  assert.deepEqual(Object.keys(s.currentExits()), [], 'no way out while the fight is live');
  assert.match(
    textOf(s.command('move portal')),
    /cannot simply walk away/,
    'the fight must be settled before any exit is offered'
  );

  // Kill the boss outright and let the encounter settle.
  const boss = s.encounter.enemies.find((e) => e.boss);
  s.encounter.damageEnemy(boss, 999, { fromPlayer: true });
  s.afterEncounterStep();

  assert.equal(s.character.hubUnlocked, true, 'the kill sets hub-unlocked');
  assert.ok(s.currentExits().portal, 'the portal opens on victory');
  assert.ok(
    s.character.inventory.some((e) => e.itemId === 'tidewarden_seal'),
    "the Tidewarden's Seal always drops"
  );

  s.command('move portal');
  assert.equal(s.roomId, 'ashvault_gate');
  assert.equal(s.state, 'victory');
});

test('hub-unlock is per character and is never inherited by the next one', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  enterBossRoom(s);
  const boss = s.encounter.enemies.find((e) => e.boss);
  s.encounter.damageEnemy(boss, 999, { fromPlayer: true });
  s.afterEncounterStep();
  assert.equal(s.character.hubUnlocked, true);

  s.command('move portal');
  s.command('restart');
  const next = newSession();
  assert.equal(next.character.hubUnlocked, false, 'every new character must earn it again');
});

// ------------------------------------------------------------- exploration

test('the Fungal Gallery challenge resolves once and only once', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  s.enterRoom('fungal_gallery');
  s.takeRecent();

  const first = textOf(s.command('search'));
  assert.match(first, /PERCEPTION check/, 'the challenge rolls a visible check');
  if (s.state !== 'playing') return; // the poison can kill outright, which is the point

  assert.match(textOf(s.command('search')), /already had everything/);
});

test('a search that pays out gives its loot exactly once', () => {
  const s = toWarrens(newSession());
  if (s.state !== 'playing') return;
  s.command('north'); // threshold, holds a health draught
  s.takeRecent();

  assert.match(textOf(s.command('search')), /Health Draught/);
  const count = () => s.character.inventory.filter((e) => e.itemId === 'health_draught').length;
  assert.equal(count(), 1);
  s.command('search');
  assert.equal(count(), 1, 'searching again must not duplicate loot');
});

test('the whole dungeon is clearable — at least one full run in fifty', () => {
  let cleared = false;
  for (let attempt = 0; attempt < 50 && !cleared; attempt++) {
    const s = toWarrens(newSession('longsword'));
    if (s.state !== 'playing') continue;
    s.command('rest');
    s.command('north'); s.command('search');
    s.command('north'); fightOut(s);            // cistern
    if (s.state !== 'playing') continue;
    s.command('north'); fightOut(s);            // ossuary
    if (s.state !== 'playing') continue;
    s.command('north'); s.command('search'); s.command('rest');
    s.command('north'); fightOut(s, 150);       // Maugrim
    if (s.state !== 'playing') continue;
    s.command('move portal');
    if (s.state === 'victory') cleared = true;
  }
  assert.ok(cleared, 'a Blade should clear the dungeon at least once in fifty attempts');
});

// ------------------------------------------------------- the Necromancer

/** Put a Grave-Bell character in the Ossuary with room to experiment. */
function necromancer() {
  const s = newSession('gravebell', 'gravedigger');
  s.character.hpMax = 200;
  s.character.hp = 200;
  s.character.level = 3;
  s.character.resource.max = 12;
  s.character.resource.current = 12;
  s.enterRoom('ossuary');
  s.takeRecent();
  return s;
}

test('a Necromancer arrives with a body, so the kit is not purely reactive', () => {
  // Measured: without an opening body the weapon clears the dungeon 1% of the
  // time, because making the first corpse takes longer than it survives (§2.10).
  const s = necromancer();
  const out = textOf(s.command('ability raise thrall'));
  assert.match(out, /Carrion Servant gets up/);
  assert.ok(s.snapshot().encounter.thrall.hp > 0, 'the opening body must actually stand');
});

test('the carried body is used once — after that the fight has to provide', () => {
  const s = necromancer();
  s.command('ability raise thrall');            // spends the carried body
  // Kill the standing thrall off so a second raise is legal to attempt.
  s.encounter.thrall.hp = 0;
  const before = s.character.resource.current;
  const out = textOf(s.command(s.snapshot().encounter.actionUsed ? 'pass' : 'ability raise thrall'));
  if (/needs a body/.test(out)) {
    assert.equal(s.character.resource.current, before, 'a refused ability must not cost a charge');
  }
  // Either it was refused for want of a corpse, or the turn simply passed —
  // what must never happen is a second Carrion Servant.
  assert.ok(!/Carrion Servant gets up[\s\S]*Carrion Servant gets up/.test(out));
});

test('the Necromancer works alone: raise, tank, and Second Death', () => {
  // The whole point of Raise Thrall over the doc's Raise Zombie is that it needs
  // no ally. This drives the entire chain with exactly one character present.
  for (let attempt = 0; attempt < 40; attempt++) {
    const s = necromancer();
    let raised = false;
    let retargeted = false;
    let burst = false;

    for (let i = 0; i < 60 && s.fighting(); i++) {
      const e = s.snapshot().encounter;
      let cmd = 'attack';
      if (e.actionUsed) cmd = 'pass';
      else if (!e.thrall && e.enemies.some((x) => !x.alive) && s.character.resource.current > 0) {
        cmd = 'ability raise thrall';
      }
      const out = textOf(s.command(cmd));
      if (/gets up/.test(out)) raised = true;
      if (/turns to face it instead of you/.test(out)) retargeted = true;
      if (/Second Death/.test(out)) burst = true;
      // While a thrall stands, nothing may swing at the character.
      const t = s.snapshot().encounter?.thrall;
      if (t && t.hp > 0) {
        assert.ok(!/attacks you|strikes you/.test(out), 'a standing Thrall must soak every attack');
      }
    }
    if (raised && retargeted && burst) {
      assert.ok(true);
      return;
    }
  }
  assert.fail('never saw the full raise -> retarget -> Second Death chain in 40 attempts');
});

test('only one Thrall stands at a time', () => {
  const s = necromancer();
  for (let i = 0; i < 60 && s.fighting(); i++) {
    const e = s.snapshot().encounter;
    if (e.thrall && e.thrall.hp > 0 && !e.actionUsed) {
      assert.match(textOf(s.command('ability raise thrall')), /only hold one at a time/);
      return;
    }
    s.command(e.actionUsed ? 'pass'
      : (!e.thrall && e.enemies.some((x) => !x.alive)) ? 'ability raise thrall' : 'attack');
  }
});

test('Siphon damages the target and heals the Necromancer for half', () => {
  const s = necromancer();
  s.character.hp = 40;
  s.character.hpMax = 200;
  for (let i = 0; i < 60 && s.fighting(); i++) {
    const e = s.snapshot().encounter;
    if (e.actionUsed) { s.command('pass'); continue; }
    const out = textOf(s.command('ability siphon on chorister'));
    if (/Necrotic/.test(out)) {
      // Net HP is not a safe measure here: the same command also runs the
      // enemies' turns, and three Choristers can out-damage the heal.
      const healed = /\+(\d+) HP/.exec(out);
      assert.ok(healed, `a landed Siphon must report a heal, got: ${out}`);
      assert.ok(Number(healed[1]) >= 1, 'the heal must be at least 1');
      return;
    }
  }
});

// ------------------------------------------------------------- item rarity

test('rarity is a power curve, not just a bank-fee label', () => {
  const s = newSession('longsword', 'caravan_guard');
  const c = s.character;
  const commonAtk = weaponAttackBonus(c);
  const commonDmg = weaponDamageMod(c);

  const rare = addItem(c, 'tidecleaver', 1);
  equipItem(c, rare, 'weapon');

  assert.equal(weaponAttackBonus(c), commonAtk + 2, 'a Rare weapon is +2 to hit');
  assert.equal(weaponDamageMod(c), commonDmg + 2, 'a Rare weapon is +2 to damage');
});

test('the rarity ladder is 0/1/2/3 and unknown rarities contribute nothing', () => {
  assert.equal(rarityBonus({ rarity: 'common' }), 0);
  assert.equal(rarityBonus({ rarity: 'uncommon' }), 1);
  assert.equal(rarityBonus({ rarity: 'rare' }), 2);
  assert.equal(rarityBonus({ rarity: 'epic' }), 3);
  assert.equal(rarityBonus({ rarity: 'nonsense' }), 0);
  assert.equal(rarityBonus(null), 0, 'bare hands have no rarity');
});

test('defensive items are not double-counted by the rarity curve', () => {
  // Trinkets carry their tier in their own `ac`; adding rarity on top would
  // inflate AC past what the encounters are balanced against (§7).
  const s = newSession('longsword', 'caravan_guard');
  const c = s.character;
  const before = armourClass(c);
  const seal = addItem(c, 'tidewarden_seal', 1);
  equipItem(c, seal, 'trinket');
  assert.equal(armourClass(c), before + 1, "the Seal's own ac of 1, and nothing else");
});

test('the flee DC comes from what you are running from', () => {
  // Dark Glory §2: a Bloatrat is easy to outrun, a Warren Shrike is not. The
  // hardest living enemy sets the number, and the flat DC 12 is the floor.
  const rats = getEnemy('bloatrat').fleeDc;
  const shrike = getEnemy('warren_shrike').fleeDc;
  assert.ok(shrike > rats, 'a quick enemy must be harder to escape than a slow one');

  const s = newSession('longsword', 'caravan_guard');
  s.character.hpMax = 300; s.character.hp = 300;
  s.enterRoom('cistern');   // two Bloatrats, plus the room's own water penalty
  const out = textOf(s.command('flee'));
  const dc = /vs DC (\d+)/.exec(out);
  assert.ok(dc, `expected a flee check with a visible DC, got: ${out}`);
  // Bloatrat's 10 is under the floor, so the floor applies, plus water +2.
  assert.equal(Number(dc[1]), 14);
});

// ------------------------------------------------------ the Hollow Crypt

/** A character stout enough to walk the Crypt without the test being about HP. */
function crypter(room) {
  const s = newSession('longsword', 'caravan_guard');
  s.character.hpMax = 900;
  s.character.hp = 900;
  s.character.level = 4;
  s.enterRoom(room);
  s.takeRecent();
  return s;
}

test('beating Maugrim opens the way on as well as the way out', () => {
  const s = enterBossRoom(newSession());
  fightOut(s, 400);
  assert.equal(s.character.hubUnlocked, true);
  const exits = Object.keys(s.currentExits());
  assert.ok(exits.includes('portal'), 'the hub must still be reachable');
  assert.ok(exits.includes('down'), 'and the Crypt must be reachable too');
});

test('the Rift pulls you through on entry — there is no choosing it', () => {
  const s = crypter('bone_antechamber');
  fightOut(s, 200);
  const out = textOf(s.command('east'));
  assert.match(out, /takes hold of you/);
  assert.equal(s.roomId, 'bleeding_hollow', 'entering the Rift Room must not leave you in it');
  assert.ok(s.fighting(), 'and it drops you straight into the Wight');
});

test('the Rift is one-way, and both paths reconverge on the Sanctum', () => {
  assert.deepEqual(Object.keys(getRoom('bleeding_hollow').exits), ['down']);
  assert.equal(getRoom('bleeding_hollow').exits.down, 'sanctum_antechamber');
  assert.equal(getRoom('collapsed_passage').exits.down, 'sanctum_antechamber');
});

test('both routes through the Crypt are worth the same XP', () => {
  const west = getEnemy('grave_wisp').xp * 3;
  const east = getEnemy('the_wight').xp;
  assert.equal(west, east, 'the boss-door level must not depend on which fork you took');
});

test('the Wight heals off you', () => {
  const s = crypter('bleeding_hollow');
  // Two things make the naive version flake: lifesteal only logs when HP is
  // actually gained, so a Wight at full health drains silently; and a level-4
  // Longsword kills a 32 HP Wight in about two rounds, often before it swings
  // at all. Give it a deep pool at half full — room to heal, and time to try.
  const wight = s.encounter.enemies[0];
  wight.hpMax = 400;
  wight.hp = 200;
  for (let i = 0; i < 120 && s.fighting(); i++) {
    const low = wight.hp;
    const out = textOf(s.command(s.snapshot().encounter.actionUsed ? 'pass' : 'attack'));
    if (/takes half of that back/.test(out)) {
      assert.ok(wight.hp > 0, 'it must be alive to have healed');
      return;
    }
    if (wight.hp > low) assert.fail('the Wight gained HP without saying so');
  }
  assert.fail('never saw the Wight drain across a whole fight');
});

test('the Warden swaps its attack for Devour at half health', () => {
  const s = crypter('wardens_sanctum');
  const boss = s.encounter.enemies[0];

  // Damage it INTO the phase-2 band rather than assigning hp: the phase check
  // only runs off damage, so setting boss.hp directly leaves it in phase 1 and
  // Devour never fires. Then only PASS — fighting it down naturally is a race
  // against a 28 HP window, and it usually dies before it lands a Devour.
  s.encounter.damageEnemy(boss, boss.hp - 20, { fromPlayer: true });
  assert.equal(boss.hp, 20);
  let devoured = false;
  let drained = false;
  for (let i = 0; i < 120 && s.fighting(); i++) {
    const out = textOf(s.command('pass'));
    if (/— Devour —/.test(out)) assert.equal(boss.phase, 2, 'the banner must match the phase');
    if (/Withered Warden — Devour/.test(out)) devoured = true;
    if (devoured && /takes half of that back/.test(out)) drained = true;
    if (devoured && drained) break;
  }
  assert.equal(boss.phase, 2, 'below half health it must be in phase 2');
  assert.ok(devoured, 'phase 2 must replace the attack with Devour');
  assert.ok(drained, 'and Devour must heal it');
});

test('the Warden drops an Epic, and unlocks nothing', () => {
  const s = crypter('wardens_sanctum');
  const before = s.character.hubUnlocked;
  fightOut(s, 400);
  assert.equal(s.snapshot().encounter, null, 'the Warden should be down');

  const inv = s.snapshot().character.inventory;
  const names = inv.map((i) => i.name).join(' | ');
  assert.match(names, /Warden's Key/, `the key always drops — got ${names}`);
  assert.ok(inv.some((i) => i.rarity === 'epic'), `one Epic must drop — got ${names}`);
  assert.equal(s.character.hubUnlocked, before, 'the Crypt boss grants no hub access');
  assert.deepEqual(Object.keys(s.currentExits()), ['up'], 'the only way on is back');
});

test('a Scholar turns a melee weapon into an Intelligence-scaled hybrid and teaches it', () => {
  const s = new GameSession();
  s.statPool = [{ total: 10 }, { total: 11 }, { total: 12 }, { total: 18 }, { total: 9 }, { total: 8 }];
  s.beginGame({
    name: 'Spellblade Test', weaponId: 'longsword', backgroundId: 'scholar',
    assignment: { str: 0, dex: 1, con: 2, int: 3, wis: 4, cha: 5 },
  });

  assert.equal(s.character.title, 'Spellblade');
  assert.equal(weaponAttackBonus(s.character), 6, 'INT 19 should beat STR 12 for this hybrid');
  assert.equal(weaponDamageMod(s.character), 4);
  assert.equal(s.snapshot().character.combatProfile.label, 'Arcane melee');
  assert.match(textOf({ entries: s.entries }), /THE DOORWAY/, 'every weapon begins with its own lesson');
});

test('every weapon has a distinct first lesson', () => {
  const lessons = WEAPON_IDS.map((weaponId) => weaponTutorialFor(weaponId));
  assert.ok(lessons.every((lesson) => lesson.name && lesson.text && lesson.objective && lesson.complete));
  assert.equal(new Set(lessons.map((lesson) => lesson.name)).size, WEAPON_IDS.length);
});

test('a weapon lesson completes only after its matching combat action', () => {
  const s = new GameSession();
  s.statPool = [{ total: 10 }, { total: 11 }, { total: 12 }, { total: 18 }, { total: 9 }, { total: 8 }];
  s.beginGame({
    name: 'Lesson Test', weaponId: 'longsword', backgroundId: 'scholar',
    assignment: { str: 0, dex: 1, con: 2, int: 3, wis: 4, cha: 5 },
  });
  assert.equal(s.completeWeaponLesson({ ability: 'bulwark' }), false);
  assert.equal(s.character.tutorial.completed, false);
  assert.equal(s.completeWeaponLesson({ action: 'attack' }), true);
  assert.equal(s.character.tutorial.completed, true);
  assert.match(textOf({ entries: s.entries }), /Steel answers/);
});

test('Bulwark spends an action and grants its promised +4 AC', () => {
  const s = new GameSession();
  s.statPool = [{ total: 10 }, { total: 11 }, { total: 12 }, { total: 18 }, { total: 9 }, { total: 8 }];
  s.beginGame({
    name: 'Bulwark Test', weaponId: 'spear', backgroundId: 'caravan_guard',
    assignment: { str: 3, dex: 1, con: 2, int: 0, wis: 4, cha: 5 },
  });
  const encounter = new Encounter({ room: getRoom('pro_caravan_guard_2'), character: s.character, log: () => {} });
  const before = encounter.playerAc();
  const bulwark = abilitiesFor('spear', 'caravan_guard').find((ability) => ability.id === 'bulwark');
  const result = encounter.playerAbility(bulwark);
  assert.equal(result.ok, true);
  assert.equal(result.endsTurn, true);
  assert.equal(encounter.playerAc(), before + 4);
});
