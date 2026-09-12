import test from 'node:test';
import assert from 'node:assert/strict';

import {
  abilityMod,
  proficiencyBonus,
  levelForXp,
  xpToNextLevel,
  startingHp,
  computeAc,
  effectiveMaxHp,
  resourceMax,
  skillMod,
  saveMod,
  spellSaveDc,
  XP_TABLE,
  SOLO_HP_ALLOWANCE,
} from '../server/rules.js';

test('abilityMod follows floor((score - 10) / 2)', () => {
  assert.equal(abilityMod(3), -4);
  assert.equal(abilityMod(8), -1);
  assert.equal(abilityMod(9), -1);
  assert.equal(abilityMod(10), 0);
  assert.equal(abilityMod(11), 0);
  assert.equal(abilityMod(12), 1);
  assert.equal(abilityMod(18), 4);
  assert.equal(abilityMod(20), 5);
});

test('proficiency is +2 through level 4 and +3 from level 5', () => {
  assert.equal(proficiencyBonus(1), 2);
  assert.equal(proficiencyBonus(4), 2);
  assert.equal(proficiencyBonus(5), 3);
});

test('XP thresholds match the dungeon that actually exists', () => {
  const prologue = 10;
  const cistern = 20;
  const ossuary = 60;
  const preOssuary = prologue + cistern; // 30
  const preBoss = preOssuary + ossuary; // 90

  assert.equal(levelForXp(0), 1);
  assert.equal(
    levelForXp(preOssuary),
    2,
    'level 2 BEFORE the Ossuary — fighting it at level 1 was unwinnable for the squishier classes'
  );
  assert.equal(levelForXp(preBoss), 3, 'level 3 at the boss door, as §4.6 promises');
  assert.equal(levelForXp(preBoss + 150), 3, 'Maugrim does not push past level 3');
});

test('xpToNextLevel reports remaining XP and null at cap', () => {
  assert.equal(xpToNextLevel(0), 30);
  assert.equal(xpToNextLevel(90), 310);
  assert.equal(xpToNextLevel(800), null);
});

test('starting HP is a maxed hit die plus CON plus the solo allowance', () => {
  assert.equal(startingHp(10, 2), 10 + 2 + SOLO_HP_ALLOWANCE); // Blade, CON 14
  assert.equal(startingHp(6, 1), 6 + 1 + SOLO_HP_ALLOWANCE); // Emberwright, CON 12
  assert.equal(startingHp(6, -20), 1, 'never below 1');
});

test('the solo allowance lifts every class out of the two-hit-kill band', () => {
  // The heaviest pre-boss hit is a Bone Chorister crit: 1d6 doubled, so 2d6,
  // averaging 7. No class should be one-shot from full by a typical crit at
  // level 1 — that was routine before the allowance existed.
  const AVERAGE_CRIT = 7;
  for (const [hitDie, conMod] of [[10, 2], [8, 1], [6, 0]]) {
    assert.ok(
      startingHp(hitDie, conMod) > AVERAGE_CRIT,
      `d${hitDie} with CON mod ${conMod} dies to an average crit`
    );
  }
  // A maximum-roll crit (12) can still kill a d6 class that dumped CON. That is
  // left in deliberately: this is a permadeath game and the frailest possible
  // build should be able to lose to a genuinely terrible roll.
  assert.ok(startingHp(6, 0) < 12);
});

const character = (over = {}) => ({
  level: 1,
  abilities: { str: 10, dex: 16, con: 14, int: 10, wis: 12, cha: 8 },
  acBonuses: [],
  skillProficiencies: [],
  saveProficiencies: [],
  hpMax: 20,
  hpMaxPenalty: 0,
  ...over,
});

test('computeAc respects flat armour, DEX armour, and DEX caps', () => {
  const chain = { armour: { base: 16, dexBonus: false, dexMax: 0 } };
  const leather = { armour: { base: 11, dexBonus: true, dexMax: null } };
  const scale = { armour: { base: 14, dexBonus: true, dexMax: 2 } };

  assert.equal(computeAc(character(), chain), 16, 'chain ignores DEX entirely');
  assert.equal(computeAc(character(), leather), 14, '11 + DEX 3');
  assert.equal(computeAc(character(), scale), 16, '14 + min(DEX 3, cap 2)');
});

test('computeAc adds equipment bonuses such as a shield', () => {
  const chain = { armour: { base: 16, dexBonus: false, dexMax: 0 } };
  assert.equal(computeAc(character({ acBonuses: [2] }), chain), 18);
  assert.equal(computeAc(character({ acBonuses: [2, 1] }), chain), 19);
});

test("Drowning Song's max-HP drain reduces effective max HP but never below 1", () => {
  assert.equal(effectiveMaxHp(character({ hpMax: 24, hpMaxPenalty: 0 })), 24);
  assert.equal(effectiveMaxHp(character({ hpMax: 24, hpMaxPenalty: 9 })), 15);
  assert.equal(effectiveMaxHp(character({ hpMax: 24, hpMaxPenalty: 99 })), 1);
});

test('resource pool is level + casting mod, and zero for non-casters', () => {
  const ember = { resource: { ability: 'int', name: 'Embers' } };
  assert.equal(resourceMax(ember, character({ level: 1, abilities: { ...character().abilities, int: 16 } })), 4);
  assert.equal(resourceMax(ember, character({ level: 3, abilities: { ...character().abilities, int: 16 } })), 6);
  assert.equal(resourceMax({ resource: null }, character()), 0);
});

test('skill proficiency from a background adds the proficiency bonus', () => {
  const gravedigger = character({ skillProficiencies: ['perception'] });
  assert.equal(skillMod(gravedigger, 'perception'), 1 + 2, 'WIS 12 (+1) plus proficiency');
  assert.equal(skillMod(character(), 'perception'), 1, 'unproficient is the bare ability mod');
});

test('class save proficiency adds the proficiency bonus', () => {
  const blade = character({ saveProficiencies: ['str', 'con'] });
  assert.equal(saveMod(blade, 'con'), 2 + 2);
  assert.equal(saveMod(blade, 'dex'), 3, 'not proficient in DEX saves');
});

test('spell save DC is 8 + proficiency + casting mod', () => {
  const caster = character({ abilities: { ...character().abilities, int: 17 } });
  assert.equal(spellSaveDc(caster, 'int'), 8 + 2 + 3);
});
