// Dice engine. GAME_DESIGN.md §1.
//
// This module is deliberately free of game logic. It knows about dice, modifiers,
// advantage, and how to decide hit/miss against a number it is handed. It does not
// know what a Bloatrat is. Everything that touches randomness in the game goes
// through here so there is exactly one RNG and exactly one audit shape.

import { randomInt, randomUUID } from 'node:crypto';

/** A single fair die. Uses crypto RNG — never Math.random. */
export function rollDie(sides) {
  if (!Number.isInteger(sides) || sides < 2) {
    throw new RangeError(`rollDie: sides must be an integer >= 2, got ${sides}`);
  }
  return randomInt(1, sides + 1);
}

const NOTATION = /^(\d*)d(\d+)([+-]\d+)?$/i;

/** '2d8+3' -> { count: 2, sides: 8, modifier: 3 } */
export function parseNotation(notation) {
  const m = NOTATION.exec(String(notation).trim().replace(/\s+/g, ''));
  if (!m) throw new SyntaxError(`Unparseable dice notation: "${notation}"`);
  const count = m[1] === '' ? 1 : Number(m[1]);
  const sides = Number(m[2]);
  const modifier = m[3] ? Number(m[3]) : 0;
  if (count < 1 || count > 100) throw new RangeError(`Die count out of range: ${count}`);
  return { count, sides, modifier };
}

/**
 * The canonical roll. Returns a RollResult (GAME_DESIGN §1.5).
 *
 * `kept` / `dropped` are a superset of the documented shape — they exist so the
 * client can render advantage and 4d6-drop-lowest honestly rather than hiding
 * the discarded die.
 *
 * opts:
 *   modifier   extra modifier added on top of any in the notation
 *   kind       'attack' | 'check' | 'save' | 'damage' | 'raw'  (drives `outcome`)
 *   vs         the AC or DC to beat, or null
 *   vsLabel    'AC' | 'DC' — display only
 *   advantage  'none' | 'advantage' | 'disadvantage'  (d20 rolls only)
 *   keep       'highest' | 'lowest' | number — keep N dice (used by stat generation)
 *   purpose    free-text audit string, e.g. 'attack:bloatrat_1'
 */
export function roll(notation, opts = {}) {
  const {
    modifier = 0,
    kind = 'raw',
    vs = null,
    vsLabel = 'DC',
    advantage = 'none',
    keep = null,
    purpose = kind,
    characterId = null,
    source = 'server',
  } = opts;

  const parsed = parseNotation(notation);
  const totalModifier = parsed.modifier + modifier;

  let dice = [];
  let kept = [];
  let dropped = [];

  if (advantage !== 'none' && parsed.count === 1 && parsed.sides === 20) {
    dice = [rollDie(20), rollDie(20)];
    const pick = advantage === 'advantage' ? Math.max(...dice) : Math.min(...dice);
    const pickIndex = dice.indexOf(pick);
    kept = [dice[pickIndex]];
    dropped = dice.filter((_, i) => i !== pickIndex);
  } else {
    dice = Array.from({ length: parsed.count }, () => rollDie(parsed.sides));
    if (keep === null) {
      kept = [...dice];
    } else {
      const sorted = [...dice].sort((a, b) => b - a);
      const n = typeof keep === 'number' ? keep : parsed.count - 1;
      kept = keep === 'lowest' ? sorted.slice(-n) : sorted.slice(0, n);
      // Remove kept values from a working copy to determine what was dropped.
      const pool = [...dice];
      for (const k of kept) pool.splice(pool.indexOf(k), 1);
      dropped = pool;
    }
  }

  const sum = kept.reduce((a, b) => a + b, 0);
  const total = sum + totalModifier;

  const natural = parsed.sides === 20 && kept.length === 1 ? kept[0] : null;
  const outcome = decideOutcome({ kind, total, vs, natural });

  return {
    id: randomUUID(),
    characterId,
    notation: displayNotation(parsed, totalModifier),
    dice,
    kept,
    dropped,
    modifier: totalModifier,
    total,
    natural,
    purpose,
    vs,
    vsLabel,
    advantage,
    kind,
    outcome,
    source,
    verified: source === 'server',
    createdAt: new Date().toISOString(),
  };
}

// Nat 20 / nat 1 matter on attacks only — never on checks or saves (§1.3).
function decideOutcome({ kind, total, vs, natural }) {
  if (kind === 'attack') {
    if (natural === 20) return 'crit';
    if (natural === 1) return 'fumble';
    if (vs === null) return null;
    return total >= vs ? 'hit' : 'miss';
  }
  if (kind === 'check' || kind === 'save') {
    if (vs === null) return null;
    return total >= vs ? 'success' : 'failure';
  }
  return null;
}

function displayNotation({ count, sides }, modifier) {
  const mod = modifier === 0 ? '' : modifier > 0 ? `+${modifier}` : `${modifier}`;
  return `${count}d${sides}${mod}`;
}

/** d20 attack roll against an AC. */
export function rollAttack(modifier, ac, opts = {}) {
  return roll('1d20', { ...opts, modifier, kind: 'attack', vs: ac, vsLabel: 'AC' });
}

/** d20 ability check or saving throw against a DC. */
export function rollCheck(modifier, dc, opts = {}) {
  return roll('1d20', { ...opts, modifier, kind: 'check', vs: dc, vsLabel: 'DC' });
}

export function rollSave(modifier, dc, opts = {}) {
  return roll('1d20', { ...opts, modifier, kind: 'save', vs: dc, vsLabel: 'DC' });
}

/**
 * Damage. On a crit the dice are rolled twice and the modifier added once (§1.3),
 * which we express by doubling the die count so the log line stays honest:
 * a crit with a longsword reads "2d8+3", not "1d8+3 (doubled)".
 */
export function rollDamage(notation, modifier = 0, opts = {}) {
  const parsed = parseNotation(notation);
  const count = opts.crit ? parsed.count * 2 : parsed.count;
  return roll(`${count}d${parsed.sides}`, {
    ...opts,
    modifier: modifier + parsed.modifier,
    kind: 'damage',
    purpose: opts.purpose ?? (opts.crit ? 'damage:crit' : 'damage'),
  });
}

/** §1.2 — 4d6 drop lowest, six times. The pool the player gets is the pool they keep. */
export function rollStatPool(characterId = null) {
  return Array.from({ length: 6 }, () =>
    roll('4d6', { keep: 3, purpose: 'statgen', characterId })
  );
}

/**
 * Render a roll the way the player must always be able to read it (§12):
 *   "1d20+4 → [17]+4 = 21 vs AC 13 — HIT"
 */
export function formatRoll(r) {
  const dicePart = r.dropped.length
    ? `[${r.kept.join(', ')}] (dropped ${r.dropped.join(', ')})`
    : `[${r.kept.join(', ')}]`;
  const modPart = r.modifier === 0 ? '' : r.modifier > 0 ? `+${r.modifier}` : `${r.modifier}`;
  const advPart =
    r.advantage === 'advantage' ? ' adv' : r.advantage === 'disadvantage' ? ' dis' : '';
  let line = `${r.notation}${advPart} → ${dicePart}${modPart} = ${r.total}`;
  if (r.vs !== null && r.vs !== undefined) line += ` vs ${r.vsLabel} ${r.vs}`;
  if (r.outcome) line += ` — ${r.outcome.toUpperCase()}`;
  if (!r.verified) line += ' — UNVERIFIED (honour system)';
  return line;
}
