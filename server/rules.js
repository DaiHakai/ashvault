// Derived-stat rules. GAME_DESIGN.md §1, §2, §4.6.
// Pure functions only — no randomness, no state. Everything here is testable.

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export const ABILITY_NAMES = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

/** Skill -> governing ability (§3). */
export const SKILL_ABILITY = {
  perception: 'wis',
  athletics: 'str',
  arcana: 'int',
  stealth: 'dex',
};

export const DC = { easy: 8, moderate: 12, hard: 16, veryHard: 20 };

export function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

/** §1.4 — +2 at levels 1-4, +3 at 5-8. */
export function proficiencyBonus(level) {
  return level >= 5 ? 3 : 2;
}

/**
 * §4.6 XP table.
 *
 * NOTE (deviation from GAME_DESIGN v0.1 as first written): the doc listed
 * level 3 at 180 XP and claimed the player reaches level 3 "at the boss door".
 * The dungeon only contains 90 XP of pre-boss encounters (10 tutorial + 20
 * Cistern + 60 Ossuary), so 180 was unreachable before Maugrim. Level 3 is
 * therefore 90, which makes the doc's stated pacing literally true. Levels 4
 * and 5 keep their original thresholds so Maugrim's 150 XP lands the character
 * at level 3 and no further — 4 and 5 belong to post-hub content that does not
 * exist yet.
 *
 * Level 2 was also pulled from 60 to 30. At 60 the player reached level 2
 * partway *through* the Ossuary — the hardest pre-boss encounter was fought at
 * level 1, at the character's weakest, and simulation showed the squishier
 * classes could not win it at full HP no matter how well they played. At 30 the
 * prologue kill plus the Cistern levels you before you open that door.
 *
 * GAME_DESIGN.md §4.6 has been corrected to match.
 */
export const XP_TABLE = [0, 0, 30, 90, 400, 800];
export const MAX_LEVEL = 5;

export function levelForXp(xp) {
  let level = 1;
  for (let l = 2; l <= MAX_LEVEL; l++) {
    if (xp >= XP_TABLE[l]) level = l;
  }
  return level;
}

export function xpToNextLevel(xp) {
  const level = levelForXp(xp);
  if (level >= MAX_LEVEL) return null;
  return XP_TABLE[level + 1] - xp;
}

/**
 * §2 — level 1 HP is a maxed hit die plus CON mod, plus a flat solo allowance.
 *
 * The doc's formula is the d20 standard, which assumes a party of four sharing
 * incoming damage. Phase 1 is explicitly solo, and playtesting at the original
 * numbers produced a 0% clear rate over 800 simulated runs: a level-1 Emberwright
 * had 7 HP against enemies dealing 4-6 per hit. The flat +5 lifts characters out
 * of the two-hit-kill band at level 1, where nearly all deaths were happening,
 * without touching the per-level rolls or the shape of the maths anywhere else.
 */
export const SOLO_HP_ALLOWANCE = 5;

/**
 * The same allowance, smaller, on each level gained. Deaths cluster in the
 * Ossuary and the boss room, which are levels 2-3, so the level-1 constant alone
 * did not reach them.
 */
export const LEVEL_HP_ALLOWANCE = 3;

export function startingHp(hitDie, conMod) {
  return Math.max(1, hitDie + conMod + SOLO_HP_ALLOWANCE);
}

/** §2 — armour class from class armour, equipped items, and DEX. */
export function computeAc(character, weaponDef) {
  const dexMod = abilityMod(character.abilities.dex);
  const armour = weaponDef.armour;
  let ac = armour.base;
  if (armour.dexBonus) {
    ac += armour.dexMax === null ? dexMod : Math.min(dexMod, armour.dexMax);
  }
  for (const bonus of character.acBonuses ?? []) ac += bonus;
  return ac;
}

/** Effective max HP after Maugrim's Drowning Song drain (§5.4 phase 3). */
export function effectiveMaxHp(character) {
  return Math.max(1, character.hpMax - (character.hpMaxPenalty ?? 0));
}

/** §2 — Embers (INT) / Oil (WIS), sized by level + casting mod. */
export function resourceMax(weaponDef, character) {
  if (!weaponDef.resource) return 0;
  const mod = abilityMod(character.abilities[weaponDef.resource.ability]);
  return Math.max(0, character.level + mod);
}

/** Attack bonus for a weapon: proficiency + the governing ability mod. */
export function attackBonus(character, ability) {
  return proficiencyBonus(character.level) + abilityMod(character.abilities[ability]);
}

/** §2.3/§2.4 — spell save DC = 8 + proficiency + casting mod. */
export function spellSaveDc(character, ability) {
  return 8 + proficiencyBonus(character.level) + abilityMod(character.abilities[ability]);
}

/** Ability check modifier, including background skill proficiency (§3). */
export function skillMod(character, skill) {
  const ability = SKILL_ABILITY[skill];
  const base = abilityMod(character.abilities[ability]);
  const proficient = character.skillProficiencies?.includes(skill);
  return proficient ? base + proficiencyBonus(character.level) : base;
}

/** Saving throw modifier, including class save proficiency (§2). */
export function saveMod(character, ability) {
  const base = abilityMod(character.abilities[ability]);
  const proficient = character.saveProficiencies?.includes(ability);
  return proficient ? base + proficiencyBonus(character.level) : base;
}

/**
 * Rarity power curve (§7).
 *
 * Before this, rarity was a label that did nothing but set the bank's deposit
 * fee — a Rare sword and a Common one hit exactly as hard, which made the whole
 * loot table decorative. A rarer weapon now adds this to both attack and damage.
 *
 * It applies to weapons only. Defensive items carry their tier directly in their
 * own `ac` value, hand-tuned per item; adding a second rarity bonus on top would
 * double-count and quietly inflate AC past what the encounters are balanced for.
 */
export const RARITY_BONUS = { common: 0, uncommon: 1, rare: 2, epic: 3 };

export function rarityBonus(item) {
  if (!item) return 0;
  return RARITY_BONUS[item.rarity] ?? 0;
}

export function formatMod(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}
