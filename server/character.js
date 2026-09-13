// Character construction and derived state. GAME_DESIGN.md §1.2, §2, §3.
//
// Shapes mirror the `characters` table in §9 so Phase 2 is a persistence swap
// rather than a rewrite. Anything that would be a column there is a top-level
// field here, in the same snake-to-camel spelling.

import { randomUUID } from 'node:crypto';
import { roll, rollDamage } from './dice.js';
import {
  getWeapon, getBackground, getItem, abilitiesFor, titleFor, refusalFor, isBackgroundLocked, combatProfileFor,
} from './content.js';
import {
  ABILITIES,
  abilityMod,
  startingHp,
  computeAc,
  resourceMax,
  proficiencyBonus,
  effectiveMaxHp,
  rarityBonus,
  LEVEL_HP_ALLOWANCE,
} from './rules.js';

let uidCounter = 0;
const nextUid = () => `u${++uidCounter}`;

const MAX_ABILITY_SCORE = 20;

/**
 * Build a character from a stat pool and the player's assignment.
 * `assignment` maps ability -> index into the pool. Every index exactly once.
 */
export function createCharacter({ name, weaponId, backgroundId, assignment, statPool }) {
  const weaponDef = getWeapon(weaponId);
  const bgDef = getBackground(backgroundId);

  // Backgrounds held back for a later version are not rollable, and the check
  // lives here rather than in the UI because the client is never trusted (§3.3).
  if (isBackgroundLocked(backgroundId)) {
    throw new Error(`${getBackground(backgroundId).name} is not available yet.`);
  }

  // Some pasts refuse some weapons (§3.1). The content carries the reason.
  const refusal = refusalFor(weaponId, backgroundId);
  if (refusal) throw new Error(refusal);

  validateAssignment(assignment);
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('A character needs a name.');
  if (trimmed.length > 24) throw new Error('That name is too long (24 characters at most).');

  const abilities = {};
  for (const ability of ABILITIES) {
    const base = statPool[assignment[ability]].total;
    const bonus = (weaponDef.abilityBonus[ability] ?? 0) + (bgDef.abilityBonus[ability] ?? 0);
    abilities[ability] = Math.min(MAX_ABILITY_SCORE, base + bonus);
  }

  const character = {
    id: randomUUID(),
    name: trimmed,
    weaponId,
    backgroundId,
    // Identity is generated from the pair, not chosen from a roster (§2).
    title: titleFor(weaponId, backgroundId),
    abilities,

    level: 1,
    xp: 0,
    hpMax: 0,
    hp: 0,
    hpMaxPenalty: 0,

    resource: null,
    marks: weaponDef.marks,

    inventory: [],
    equipment: { weapon: null, offhand: null, trinket: null },

    skillProficiencies: [bgDef.skillProficiency],
    saveProficiencies: [...weaponDef.saveProficiencies],

    status: 'alive',
    hubUnlocked: false,
    usedManualDice: false,
    lastBreathUsed: false,

    // Per-rest ability uses, keyed by ability id. Cleared by REST.
    restUses: {},
    // Per-dungeon item and background-ability uses. Cleared by nothing in Phase 1.
    dungeonUses: {},
    // Set by Marginalia; consumed by the next attack, check or save.
    pendingAdvantage: false,

    createdAt: new Date().toISOString(),
    diedAt: null,
    killedBy: null,
    deathRoom: null,
  };

  character.hpMax = startingHp(weaponDef.hitDie, abilityMod(abilities.con));
  character.hp = character.hpMax;

  if (weaponDef.resource) {
    const max = resourcePool(character);
    character.resource = {
      id: weaponDef.resource.id,
      name: weaponDef.resource.name,
      current: max,
      max,
    };
  }

  for (const entry of weaponDef.kit) {
    const added = addItem(character, entry.item, entry.qty ?? 1);
    if (entry.equip) equipItem(character, added, entry.equip);
  }
  addItem(character, bgDef.startingItem, 1);

  return character;
}

function validateAssignment(assignment) {
  if (!assignment || typeof assignment !== 'object') {
    throw new Error('Assign each rolled score to an ability.');
  }
  const seen = new Set();
  for (const ability of ABILITIES) {
    const index = assignment[ability];
    if (!Number.isInteger(index) || index < 0 || index > 5) {
      throw new Error(`Bad assignment for ${ability.toUpperCase()}.`);
    }
    if (seen.has(index)) throw new Error('Each rolled score can only be used once.');
    seen.add(index);
  }
  if (seen.size !== 6) throw new Error('All six scores must be assigned.');
}

// ---------------------------------------------------------------- inventory

export function addItem(character, itemId, qty = 1) {
  const def = getItem(itemId);
  if (def.consumable) {
    const stack = character.inventory.find((s) => s.itemId === itemId);
    if (stack) {
      stack.qty += qty;
      return stack;
    }
  }
  const entry = { uid: nextUid(), itemId, qty: def.consumable ? qty : 1 };
  character.inventory.push(entry);
  if (!def.consumable && qty > 1) {
    for (let i = 1; i < qty; i++) character.inventory.push({ uid: nextUid(), itemId, qty: 1 });
  }
  return entry;
}

export function removeItem(character, entry, qty = 1) {
  const index = character.inventory.indexOf(entry);
  if (index === -1) return;
  if (entry.qty > qty) {
    entry.qty -= qty;
    return;
  }
  character.inventory.splice(index, 1);
  for (const slot of Object.keys(character.equipment)) {
    if (character.equipment[slot] === entry.uid) character.equipment[slot] = null;
  }
}

export function equipItem(character, entry, slot) {
  character.equipment[slot] = entry.uid;
}

export function findInventory(character, uid) {
  return character.inventory.find((e) => e.uid === uid) ?? null;
}

export function equippedEntry(character, slot) {
  const uid = character.equipment[slot];
  return uid ? findInventory(character, uid) : null;
}

export function equippedItem(character, slot) {
  const entry = equippedEntry(character, slot);
  return entry ? getItem(entry.itemId) : null;
}

// ---------------------------------------------------------------- derived

const FISTS = {
  id: 'fists',
  name: 'Bare hands',
  damage: '1d2',
  ability: 'str',
  range: 'melee',
};

export function weaponOf(character) {
  return equippedItem(character, 'weapon') ?? FISTS;
}

export function acBonuses(character) {
  const bonuses = [];
  for (const slot of ['offhand', 'trinket']) {
    const item = equippedItem(character, slot);
    if (item?.ac) bonuses.push(item.ac);
  }
  return bonuses;
}

export function saveItemBonus(character) {
  let bonus = 0;
  for (const slot of ['offhand', 'trinket']) {
    const item = equippedItem(character, slot);
    if (item?.saveBonus) bonus += item.saveBonus;
  }
  return bonus;
}

export function armourClass(character) {
  const weaponDef = getWeapon(character.weaponId);
  const bonuses = [...acBonuses(character), traitAmount(character, 'acBonus')];
  return computeAc({ ...character, acBonuses: bonuses }, weaponDef);
}

/** Resource ceiling including any background bonus (Apostate's Unbound). */
export function resourcePool(character) {
  const weaponDef = getWeapon(character.weaponId);
  if (!weaponDef.resource) return 0;
  return resourceMax(weaponDef, character) + traitAmount(character, 'resourceBonus');
}

export function knownAbilities(character) {
  return abilitiesFor(character.weaponId, character.backgroundId)
    .filter((a) => a.level <= character.level);
}

export function hasAbility(character, abilityId) {
  return knownAbilities(character).some((a) => a.id === abilityId);
}

/** The active combat abilities — the things a player actually types. */
export function activeAbilities(character) {
  return knownAbilities(character).filter((a) => a.track !== 'background' || a.type === 'action' || a.type === 'command');
}

/**
 * Background passives are addressed by `hook` rather than by id, so the engine
 * asks "does this character ignore water?" instead of "is this character a
 * Ferryman?". Adding a background with an existing hook needs no engine change.
 */
export function trait(character, hook) {
  return knownAbilities(character).find((a) => a.hook === hook) ?? null;
}

export function hasTrait(character, hook) {
  return Boolean(trait(character, hook));
}

/** Numeric traits carry an `amount`; absent traits contribute nothing. */
export function traitAmount(character, hook, fallback = 0) {
  return trait(character, hook)?.amount ?? fallback;
}

/**
 * Consume a one-shot advantage if one is pending (Marginalia). Returns
 * 'advantage' or 'none' so callers can pass it straight to the dice engine.
 */
export function takePendingAdvantage(character) {
  if (!character.pendingAdvantage) return 'none';
  character.pendingAdvantage = false;
  return 'advantage';
}

export function weaponAttackBonus(character) {
  const weapon = weaponOf(character);
  const profile = combatProfileFor(character.weaponId, character.backgroundId);
  const attackMod = Math.max(...profile.attackAbilities.map((ability) => abilityMod(character.abilities[ability])));
  return proficiencyBonus(character.level)
    + attackMod
    + rarityBonus(weapon);
}

export function weaponDamageMod(character) {
  const weapon = weaponOf(character);
  const profile = combatProfileFor(character.weaponId, character.backgroundId);
  const attackMod = Math.max(...profile.attackAbilities.map((ability) => abilityMod(character.abilities[ability])));
  return attackMod + rarityBonus(weapon);
}

// ---------------------------------------------------------------- mutation

/** Apply damage. Returns { dealt, dead }. Death is the caller's to narrate. */
export function damage(character, amount) {
  const dealt = Math.max(0, Math.floor(amount));
  character.hp = Math.max(0, character.hp - dealt);
  return { dealt, dead: character.hp === 0 };
}

/** Heal, capped at effective max HP (which the Drowning Song can lower). */
export function heal(character, amount) {
  const cap = effectiveMaxHp(character);
  const before = character.hp;
  character.hp = Math.min(cap, character.hp + Math.max(0, Math.floor(amount)));
  return character.hp - before;
}

/** Drowning Song max-HP drain (§5.4 phase 3). Current HP follows the new ceiling. */
export function drainMaxHp(character, amount) {
  // Mine-Child's Deep Lungs: bad air was the whole childhood.
  const scaled = hasTrait(character, 'halveMaxHpDrain') ? amount / 2 : amount;
  character.hpMaxPenalty += Math.max(0, Math.floor(scaled));
  const cap = effectiveMaxHp(character);
  if (character.hp > cap) character.hp = cap;
}

export function spendResource(character, cost) {
  if (!character.resource || character.resource.current < cost) return false;
  character.resource.current -= cost;
  return true;
}

/**
 * Level up. Rolls the hit die (§4.6), grows the resource pool, and reports what
 * was unlocked. Current HP rises by the same amount as max — levelling mid-fight
 * is a boost, not a free full heal.
 */
export function levelUp(character) {
  const weaponDef = getWeapon(character.weaponId);
  character.level += 1;

  const hpRoll = rollDamage(`1d${weaponDef.hitDie}`, abilityMod(character.abilities.con), {
    purpose: 'levelup:hp',
    characterId: character.id,
  });
  const gained = Math.max(1, hpRoll.total) + LEVEL_HP_ALLOWANCE;
  character.hpMax += gained;
  character.hp += gained;

  let resourceGained = 0;
  if (character.resource) {
    const newMax = resourcePool(character);
    resourceGained = newMax - character.resource.max;
    character.resource.max = newMax;
    character.resource.current = Math.min(newMax, character.resource.current + Math.max(0, resourceGained));
  }

  const unlocked = abilitiesFor(character.weaponId).filter((a) => a.level === character.level);
  return { hpRoll, hpGained: gained, resourceGained, unlocked };
}

/** REST at a shrine (§4.5): full HP, full resource, per-rest and per-encounter uses back. */
export function restoreOnRest(character) {
  character.hp = effectiveMaxHp(character);
  if (character.resource) character.resource.current = character.resource.max;
  character.restUses = {};
}

export function kill(character, { killedBy, room }) {
  character.status = 'dead';
  character.hp = 0;
  character.diedAt = new Date().toISOString();
  character.killedBy = killedBy;
  character.deathRoom = room;
  // §6.1 — carried inventory is destroyed, not dropped. The record of what was
  // lost is returned for the memorial; the items themselves are gone.
  const lost = character.inventory.map((e) => ({ itemId: e.itemId, qty: e.qty }));
  character.inventory = [];
  character.equipment = { weapon: null, offhand: null, trinket: null };
  character.marks = 0;
  return lost;
}

/** Roll a stat pool. Exported here so the session layer never imports dice directly. */
export function rollStats(characterId = null) {
  return Array.from({ length: 6 }, () =>
    roll('4d6', { keep: 3, purpose: 'statgen', characterId })
  );
}
