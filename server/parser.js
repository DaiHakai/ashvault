// Command parser. GAME_DESIGN.md §10.
//
// Verb-first, case-insensitive, tolerant of articles and filler words.
// Rule: never return a bare parse error. An unrecognised verb always comes back
// with the closest legal verb attached, because "I don't understand" is the
// fastest way to make a text game feel hostile.

export const COMMANDS = {
  look: { verb: 'look', aliases: ['l', 'examine', 'x', 'inspect'], arg: 'optional' },
  move: { verb: 'move', aliases: ['go', 'walk', 'head'], arg: 'required' },
  attack: { verb: 'attack', aliases: ['a', 'hit', 'strike'], arg: 'optional' },
  ability: { verb: 'ability', aliases: ['cast', 'invoke'], arg: 'required' },
  inventory: { verb: 'inventory', aliases: ['i', 'inv', 'bag'], arg: 'none' },
  equip: { verb: 'equip', aliases: ['wield', 'wear'], arg: 'required' },
  unequip: { verb: 'unequip', aliases: ['remove', 'stow'], arg: 'required' },
  use: { verb: 'use', aliases: ['drink', 'quaff', 'eat'], arg: 'required' },
  search: { verb: 'search', aliases: ['loot', 'forage', 'investigate', 'investigation', 'rummage', 'scavenge'], arg: 'none' },
  rest: { verb: 'rest', aliases: ['sleep', 'pray'], arg: 'none' },
  climb: { verb: 'climb', aliases: ['mount'], arg: 'none' },
  descend: { verb: 'descend', aliases: ['dismount'], arg: 'none' },
  defend: { verb: 'defend', aliases: ['guard', 'block'], arg: 'none' },
  pass: { verb: 'pass', aliases: ['wait', 'skip'], arg: 'none' },
  flee: { verb: 'flee', aliases: ['run', 'retreat', 'escape'], arg: 'none' },
  sheet: { verb: 'sheet', aliases: ['character', 'stats', 'c'], arg: 'none' },
  // Background-granted commands. Only characters with the trait can use them,
  // but the parser knows them regardless so the refusal can explain itself.
  foresee: { verb: 'foresee', aliases: ['foresight'], arg: 'none' },
  recant: { verb: 'recant', aliases: ['renounce'], arg: 'none' },
  help: { verb: 'help', aliases: ['?', 'commands'], arg: 'optional' },
  restart: { verb: 'restart', aliases: ['new'], arg: 'none' },
};

/** Bare compass words are shorthand for `move <direction>`. */
export const DIRECTIONS = {
  n: 'north', north: 'north',
  s: 'south', south: 'south',
  e: 'east', east: 'east',
  w: 'west', west: 'west',
  u: 'up', up: 'up',
  d: 'down', down: 'down',
};

const FILLER = new Set(['the', 'a', 'an', 'at', 'to', 'my', 'with', 'on', 'into', 'toward', 'towards']);

// `use kindle on the rat` — the target follows `on`/`at`, everything before it is the subject.
const TARGET_SPLIT = new Set(['on', 'at', 'against']);

const VERB_LOOKUP = buildVerbLookup();

// A text adventure should understand intent, not make a player memorize a
// command manual. These are deliberately narrow, consequence-safe rewrites:
// they only choose SEARCH, which already decides whether a room has anything
// to find and whether a check is appropriate. We never turn free prose into a
// combat action or invent a target.
const SEARCH_PHRASES = [
  /^(?:roll|make|do|perform|try)(?: a| an| the)? (?:perception |investigation )?check(?: for .+)?$/,
  /^(?:can i |i want to |let me )?(?:search|investigate|rummage|scavenge|loot)(?: .+)?$/,
  /^(?:look|look around) for (?:loot|clues|anything|items?)(?: .+)?$/,
];

function buildVerbLookup() {
  const map = new Map();
  for (const cmd of Object.values(COMMANDS)) {
    map.set(cmd.verb, cmd.verb);
    for (const alias of cmd.aliases) map.set(alias, cmd.verb);
  }
  return map;
}

/**
 * Parse a raw input line.
 *
 * Returns either
 *   { ok: true,  verb, arg, target, raw }
 *   { ok: false, reason: 'empty' | 'unknown' | 'missing-arg', message, suggestion }
 */
export function parse(input) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return { ok: false, reason: 'empty', message: 'Say something.', suggestion: null };
  }

  const intent = normaliseIntent(raw);
  const words = intent.toLowerCase().split(/\s+/);
  const head = words[0];

  // Bare direction: "north", "n"
  if (DIRECTIONS[head] && words.length === 1) {
    return { ok: true, verb: 'move', arg: DIRECTIONS[head], target: null, raw };
  }

  const verb = VERB_LOOKUP.get(head);
  if (!verb) {
    const suggestion = closestVerb(head);
    return {
      ok: false,
      reason: 'unknown',
      suggestion,
      message: suggestion
        ? `I don't know "${words[0]}". Did you mean: ${suggestion}?`
        : `I don't know "${words[0]}". Try HELP for the list of commands.`,
    };
  }

  const rest = words.slice(1);

  // Split "<subject> on <target>" — but only when there is something on both
  // sides, so "look at the shrine" keeps "shrine" as the subject rather than
  // splitting into an empty subject and a target.
  let argWords = rest;
  let targetWords = [];
  const splitAt = rest.findIndex((w) => TARGET_SPLIT.has(w));
  if (splitAt > 0 && splitAt < rest.length - 1) {
    argWords = rest.slice(0, splitAt);
    targetWords = rest.slice(splitAt + 1);
  }

  const strip = (ws) => ws.filter((w) => !FILLER.has(w));
  let arg = strip(argWords).join(' ') || null;
  const target = strip(targetWords).join(' ') || null;

  if (verb === 'move' && arg && DIRECTIONS[arg]) arg = DIRECTIONS[arg];

  const spec = COMMANDS[verb];
  if (spec.arg === 'required' && !arg) {
    return {
      ok: false,
      reason: 'missing-arg',
      suggestion: verb,
      message: missingArgMessage(verb),
    };
  }

  return { ok: true, verb, arg, target, raw };
}

/** Translate a few common spoken-style requests into their safe game verb. */
export function normaliseIntent(raw) {
  const cleaned = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return SEARCH_PHRASES.some((phrase) => phrase.test(cleaned)) ? 'search' : raw;
}

function missingArgMessage(verb) {
  switch (verb) {
    case 'move':
      return 'Move where? Try MOVE NORTH, or just N.';
    case 'ability':
      return 'Which ability? Try SHEET to see what you know.';
    case 'equip':
      return 'Equip what? Try INVENTORY.';
    case 'unequip':
      return 'Unequip what? Try INVENTORY.';
    case 'use':
      return 'Use what? Try INVENTORY.';
    default:
      return `${verb.toUpperCase()} needs something to act on.`;
  }
}

/** Closest legal verb within a small edit distance — the did-you-mean engine. */
export function closestVerb(word) {
  let best = null;
  let bestDistance = Infinity;
  for (const candidate of VERB_LOOKUP.keys()) {
    if (candidate.length < 3 && word.length > 3) continue; // don't suggest "a" for "atack"
    const d = levenshtein(word, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = VERB_LOOKUP.get(candidate);
    }
  }
  // A threshold that scales. Note that plain Levenshtein scores a transposition
  // as 2 edits ("mvoe" -> "move"), and transpositions are the single most common
  // typing error, so 4-letter words need a limit of 2 to catch them.
  const limit = word.length <= 3 ? 1 : 2;
  return bestDistance <= limit ? best : null;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = [...curr];
  }
  return prev[b.length];
}

/**
 * Fuzzy-match a player-typed name against a list of candidates.
 * Used for enemies ("rat" -> "Bloatrat 2"), items, and abilities.
 * Returns the matched candidate or null. Exact > prefix > substring > close-typo.
 */
export function matchName(input, candidates, keyFn = (c) => c) {
  if (!input) return null;
  const needle = input.toLowerCase().trim();

  const keyed = candidates.map((c) => ({ c, key: String(keyFn(c)).toLowerCase() }));

  for (const { c, key } of keyed) if (key === needle) return c;
  for (const { c, key } of keyed) if (key.startsWith(needle)) return c;
  for (const { c, key } of keyed) if (key.includes(needle)) return c;
  // Match against any single word of the candidate's name, e.g. "chorister".
  for (const { c, key } of keyed) {
    if (key.split(/[\s_]+/).some((w) => w === needle || w.startsWith(needle))) return c;
  }

  let best = null;
  let bestDistance = Infinity;
  for (const { c, key } of keyed) {
    const d = levenshtein(needle, key);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  return bestDistance <= 2 ? best : null;
}

export function helpText() {
  return [
    'LOOK [thing]        study the room, or one thing in it        (L)',
    'MOVE <direction>    north / south / east / west / up / down   (N S E W U D)',
    'SEARCH / INVESTIGATE / ROLL CHECK   turn the room over properly',
    'ATTACK [enemy]      strike — bare ATTACK picks the weakest    (A)',
    'ABILITY <name> [on <enemy>]   use what your class knows',
    'DEFEND              +2 AC until your next turn',
    'PASS                do nothing and end your turn',
    'FLEE                DEX check to break off and fall back',
    'INVENTORY           what you carry                            (I)',
    'EQUIP / UNEQUIP <item>',
    'USE <item>          spend a consumable',
    'CLIMB / DESCEND     the plinth, when there is one',
    'REST                at a shrine only, and only once',
    'SHEET               your character                            (C)',
    'HELP                this list',
  ].join('\n');
}
