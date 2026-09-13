import test from 'node:test';
import assert from 'node:assert/strict';

import { parse, closestVerb, matchName, levenshtein, normaliseIntent } from '../server/parser.js';

test('canonical verbs and their aliases resolve to the same verb', () => {
  for (const input of ['look', 'l', 'examine', 'LOOK', '  Look  ']) {
    assert.equal(parse(input).verb, 'look', `failed on "${input}"`);
  }
  assert.equal(parse('i').verb, 'inventory');
  assert.equal(parse('a rat').verb, 'attack');
  assert.equal(parse('quaff draught').verb, 'use');
  assert.equal(parse('run').verb, 'flee');
});

test('bare compass words are shorthand for move', () => {
  assert.deepEqual(
    { verb: parse('n').verb, arg: parse('n').arg },
    { verb: 'move', arg: 'north' }
  );
  assert.equal(parse('down').arg, 'down');
  assert.equal(parse('move d').arg, 'down');
  assert.equal(parse('go north').arg, 'north');
});

test('filler words and articles are discarded', () => {
  assert.equal(parse('attack the bloatrat').arg, 'bloatrat');
  assert.equal(parse('use the health draught').arg, 'health draught');
  assert.equal(parse('look at the shrine').arg, 'shrine');
});

test('spoken investigation requests resolve to the safe SEARCH action', () => {
  for (const input of [
    'investigate item',
    'investigate the room',
    'roll check',
    'roll a perception check',
    'make an investigation check',
    'can I search for clues?',
    'look for loot',
  ]) {
    assert.equal(parse(input).verb, 'search', `failed on "${input}"`);
  }
  assert.equal(normaliseIntent('check inventory'), 'check inventory', 'unrelated checks remain untouched');
});

test('"<subject> on <target>" splits into arg and target', () => {
  const r = parse('ability cinderbolt on the chorister');
  assert.equal(r.verb, 'ability');
  assert.equal(r.arg, 'cinderbolt');
  assert.equal(r.target, 'chorister');
});

test('an unknown verb always comes back with a suggestion, never a bare error', () => {
  const r = parse('atack rat');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown');
  assert.equal(r.suggestion, 'attack');
  assert.match(r.message, /Did you mean: attack\?/);
});

test('did-you-mean handles the typos people actually make', () => {
  assert.equal(closestVerb('atack'), 'attack');
  assert.equal(closestVerb('invnetory'), 'inventory');
  assert.equal(closestVerb('serach'), 'search');
  assert.equal(closestVerb('flee '.trim()), 'flee');
  assert.equal(closestVerb('mvoe'), 'move');
});

test('gibberish gets pointed at HELP rather than a wrong guess', () => {
  const r = parse('xyzzy');
  assert.equal(r.ok, false);
  assert.equal(r.suggestion, null);
  assert.match(r.message, /HELP/);
});

test('a short alias is not suggested for a long typo', () => {
  // "a" is an attack alias but is a nonsense suggestion for a 5-letter word.
  assert.notEqual(closestVerb('atack'), null);
  assert.equal(closestVerb('attac'), 'attack');
});

test('missing required arguments explain what is missing', () => {
  const move = parse('move');
  assert.equal(move.ok, false);
  assert.equal(move.reason, 'missing-arg');
  assert.match(move.message, /MOVE NORTH/);

  assert.match(parse('use').message, /INVENTORY/);
  assert.match(parse('ability').message, /SHEET/);
});

test('optional-argument verbs parse fine bare', () => {
  assert.equal(parse('attack').ok, true);
  assert.equal(parse('attack').arg, null);
  assert.equal(parse('look').ok, true);
});

test('empty input is rejected without a suggestion', () => {
  assert.equal(parse('').reason, 'empty');
  assert.equal(parse('   ').reason, 'empty');
});

test('matchName resolves partial and fuzzy enemy names', () => {
  const enemies = [
    { label: 'Bloatrat 1' },
    { label: 'Bloatrat 2' },
    { label: 'Bone Chorister 1' },
  ];
  const key = (e) => e.label;
  assert.equal(matchName('bloatrat 2', enemies, key).label, 'Bloatrat 2');
  assert.equal(matchName('bloat', enemies, key).label, 'Bloatrat 1', 'prefix picks the first');
  assert.equal(matchName('chorister', enemies, key).label, 'Bone Chorister 1', 'matches a word');
  assert.equal(matchName('bloatrta 1', enemies, key).label, 'Bloatrat 1', 'tolerates a typo');
  assert.equal(matchName('dragon', enemies, key), null);
});

test('levenshtein is a real edit distance', () => {
  assert.equal(levenshtein('', ''), 0);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('atack', 'attack'), 1);
});
