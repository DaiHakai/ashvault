// Content loader. Everything a designer can change without touching JavaScript
// lives in ./content/*.json — GAME_DESIGN.md Phase 7 is "more content", and that
// is only cheap if content is data.
//
// There are no classes. A character is a WEAPON (how you fight) crossed with a
// BACKGROUND (who you were), and the pair generates a title. Adding a weapon or
// a background multiplies the identity space rather than adding to it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (file) => JSON.parse(readFileSync(path.join(here, 'content', file), 'utf8'));

/** Content files carry a `_comment` key for maintainers; it is not an entry. */
const strip = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== '_comment'));

export const ABILITIES_POOL = strip(load('abilities.json'));
export const WEAPONS = strip(load('weapons.json'));
export const BACKGROUNDS = strip(load('backgrounds.json'));
export const ITEMS = strip(load('items.json'));
export const ENEMIES = strip(load('enemies.json'));
export const ROOMS = strip(load('rooms.json'));

export function getWeapon(id) {
  const w = WEAPONS[id];
  if (!w) throw new Error(`Unknown weapon: ${id}`);
  return w;
}

export function getBackground(id) {
  const b = BACKGROUNDS[id];
  if (!b) throw new Error(`Unknown background: ${id}`);
  return b;
}

export function getItem(id) {
  const i = ITEMS[id];
  if (!i) throw new Error(`Unknown item: ${id}`);
  return i;
}

export function getEnemy(id) {
  const e = ENEMIES[id];
  if (!e) throw new Error(`Unknown enemy: ${id}`);
  return e;
}

export function getRoom(id) {
  const r = ROOMS[id];
  if (!r) throw new Error(`Unknown room: ${id}`);
  return r;
}

function resolveTrack(refs, owner, defaultTrack) {
  return (refs ?? []).map((ref) => {
    const def = ABILITIES_POOL[ref.id];
    if (!def) throw new Error(`${owner} references unknown ability: ${ref.id}`);
    return { ...def, level: ref.level, track: def.track ?? defaultTrack };
  });
}

/**
 * A character's abilities are the union of two tracks (§2, §3):
 *
 *   weapon     — the active things you press in a fight
 *   background — passives and world effects, each with an engine `hook`
 *
 * This is what makes every weapon x background pair a mechanically distinct
 * kit. Nine weapon tracks and ten background tracks produce ninety kits, and
 * adding either multiplies rather than adds.
 */
export function abilitiesFor(weaponId, backgroundId = null) {
  const fromWeapon = resolveTrack(getWeapon(weaponId).abilities, `Weapon ${weaponId}`, 'weapon');
  if (!backgroundId) return fromWeapon;
  const fromBackground = resolveTrack(
    getBackground(backgroundId).abilities,
    `Background ${backgroundId}`,
    'background'
  );
  return [...fromWeapon, ...fromBackground].sort((a, b) => a.level - b.level);
}

/**
 * Titles are written, not generated (§3.2).
 *
 * The first cut composed `background.titlePrefix + weapon.titleNoun`, which
 * technically produced 90 names but read as 10 families — every Gutter Rat was
 * Gutter-something, so the background swallowed the identity and the weapon
 * became a suffix. A generated name tells you which bucket you picked. A
 * written one tells you who you are, so all 90 are authored by hand.
 */
const TITLES = load('titles.json');

/**
 * Some pasts refuse some weapons (§3.1) — the WoW dwarf-druid rule. Kept as a
 * short forbidden list rather than a sparse allow-list, so the combination
 * space stays large: 11 prohibitions out of 90 leaves 79 playable pairs.
 *
 * Every prohibition carries its reason in the content, because a restriction
 * the player understands is world-building and one they do not is a bug report.
 */
export function refusalFor(weaponId, backgroundId) {
  return getBackground(backgroundId).forbids?.[weaponId] ?? null;
}

export function isAllowed(weaponId, backgroundId) {
  return refusalFor(weaponId, backgroundId) === null;
}

/**
 * Scope control, not deletion (§3.3).
 *
 * Six of the ten backgrounds are finished — prologue, abilities, titles, hub
 * hook — and held back so the shipped grid is 4 x 9 rather than 10 x 9. They
 * stay in the content tree because every one of their 54 titles is already
 * written, so unlocking one is a single `locked` flag and costs no writing at
 * all. Deleting them would throw away work and make the return expensive.
 */
export function isBackgroundLocked(backgroundId) {
  return getBackground(backgroundId).locked === true;
}

export function playableBackgroundIds() {
  return Object.keys(BACKGROUNDS).filter((b) => !isBackgroundLocked(b));
}

/** Pairs a player can actually roll today. */
export function validCombinationCount() {
  let n = 0;
  for (const w of Object.keys(WEAPONS)) {
    for (const b of playableBackgroundIds()) if (isAllowed(w, b)) n++;
  }
  return n;
}

/** Pairs that exist in content, including the locked ones. Used by tests. */
export function authoredCombinationCount() {
  let n = 0;
  for (const w of Object.keys(WEAPONS)) {
    for (const b of Object.keys(BACKGROUNDS)) if (isAllowed(w, b)) n++;
  }
  return n;
}

function titleEntry(weaponId, backgroundId) {
  const entry = TITLES[`${weaponId}:${backgroundId}`];
  if (!entry) {
    throw new Error(`No title written for ${weaponId}:${backgroundId} — every pair needs one`);
  }
  return entry;
}

export function titleFor(weaponId, backgroundId) {
  return titleEntry(weaponId, backgroundId).title;
}

/** One line on who this particular pairing is — shown under the name at creation. */
export function titleGlossFor(weaponId, backgroundId) {
  return titleEntry(weaponId, backgroundId).gloss;
}

/** Prologues belong to backgrounds (§5.1) — the background is the story half. */
export function startingRoomFor(backgroundId) {
  const start = getBackground(backgroundId).prologue;
  if (!start || !ROOMS[start]) {
    throw new Error(`No prologue defined for background: ${backgroundId}`);
  }
  return start;
}

/** The creation screen needs a trimmed, presentation-ready catalogue. */
export function creationCatalogue() {
  return {
    // Titles for the playable grid only. The locked backgrounds' 54 titles stay
    // in content but are not shipped to the client — no point advertising a
    // name the player cannot roll.
    titles: Object.fromEntries(
      Object.keys(WEAPONS).map((w) => [
        w,
        Object.fromEntries(
          playableBackgroundIds().map((b) => [
            b,
            { title: titleFor(w, b), gloss: titleGlossFor(w, b) },
          ])
        ),
      ])
    ),
    weapons: Object.values(WEAPONS).map((w) => ({
      id: w.id,
      name: w.name,
      figure: w.figure,
      tagline: w.tagline,
      blurb: w.blurb,
      hitDie: w.hitDie,
      primary: w.primary,
      damage: w.damage,
      range: w.range,
      armour: w.armour.name,
      resource: w.resource?.name ?? null,
      abilities: abilitiesFor(w.id).map((a) => ({ name: a.name, level: a.level, text: a.text })),
    })),
    // Backgrounds carry their own track, so the creation screen can show what a
    // pair actually plays like rather than only what it is called.
    backgrounds: playableBackgroundIds().map((id) => BACKGROUNDS[id]).map((b) => ({
      id: b.id,
      name: b.name,
      blurb: b.blurb,
      abilityBonus: b.abilityBonus,
      skillProficiency: b.skillProficiency,
      startingItem: getItem(b.startingItem).name,
      hubHook: b.hubHook,
      prologueName: getRoom(b.prologue).zoneName,
      // weaponId -> refusal text, so the creation screen can disable the chip
      // and say why rather than silently hiding it.
      forbids: b.forbids ?? {},
      abilities: resolveTrack(b.abilities, `Background ${b.id}`, 'background')
        .map((a) => ({ name: a.name, level: a.level, text: a.text })),
    })),
    // Named but not selectable — the creation screen shows these as a "later"
    // row so the grid reads as deliberately scoped rather than small.
    comingSoon: Object.values(BACKGROUNDS)
      .filter((b) => b.locked)
      .map((b) => ({ name: b.name, note: b.lockedNote })),
  };
}
