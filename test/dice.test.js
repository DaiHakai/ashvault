import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseNotation,
  roll,
  rollDie,
  rollAttack,
  rollCheck,
  rollDamage,
  rollStatPool,
  formatRoll,
} from '../server/dice.js';

const RUNS = 2000;

test('parseNotation handles the shapes the game actually uses', () => {
  assert.deepEqual(parseNotation('1d20'), { count: 1, sides: 20, modifier: 0 });
  assert.deepEqual(parseNotation('d20'), { count: 1, sides: 20, modifier: 0 });
  assert.deepEqual(parseNotation('2d8+3'), { count: 2, sides: 8, modifier: 3 });
  assert.deepEqual(parseNotation('4d6'), { count: 4, sides: 6, modifier: 0 });
  assert.deepEqual(parseNotation('1d6-1'), { count: 1, sides: 6, modifier: -1 });
  assert.throws(() => parseNotation('twenty'), SyntaxError);
  assert.throws(() => parseNotation('1d'), SyntaxError);
});

test('rollDie stays in range and covers the whole range', () => {
  const seen = new Set();
  for (let i = 0; i < RUNS; i++) {
    const v = rollDie(20);
    assert.ok(v >= 1 && v <= 20, `out of range: ${v}`);
    assert.ok(Number.isInteger(v));
    seen.add(v);
  }
  assert.equal(seen.size, 20, 'every face of a d20 should appear across 2000 rolls');
  assert.throws(() => rollDie(1), RangeError);
});

test('roll sums dice and modifiers correctly', () => {
  for (let i = 0; i < 200; i++) {
    const r = roll('3d6+2');
    assert.equal(r.dice.length, 3);
    assert.equal(r.modifier, 2);
    assert.equal(r.total, r.kept.reduce((a, b) => a + b, 0) + 2);
    assert.equal(r.notation, '3d6+2');
  }
});

test('roll merges notation modifier with the opts modifier', () => {
  const r = roll('1d6+1', { modifier: 4 });
  assert.equal(r.modifier, 5);
  assert.equal(r.total, r.kept[0] + 5);
});

test('advantage keeps the higher d20, disadvantage the lower', () => {
  for (let i = 0; i < 500; i++) {
    const adv = roll('1d20', { advantage: 'advantage' });
    assert.equal(adv.dice.length, 2);
    assert.equal(adv.kept.length, 1);
    assert.equal(adv.kept[0], Math.max(...adv.dice));
    assert.equal(adv.dropped.length, 1);

    const dis = roll('1d20', { advantage: 'disadvantage' });
    assert.equal(dis.kept[0], Math.min(...dis.dice));
  }
});

test('advantage does not apply to non-d20 rolls', () => {
  const r = roll('2d6', { advantage: 'advantage' });
  assert.equal(r.dice.length, 2);
  assert.equal(r.kept.length, 2, 'both d6 are kept — advantage is a d20 concept');
});

test('4d6 drop lowest keeps the three highest', () => {
  for (let i = 0; i < 500; i++) {
    const r = roll('4d6', { keep: 3 });
    assert.equal(r.dice.length, 4);
    assert.equal(r.kept.length, 3);
    assert.equal(r.dropped.length, 1);
    const sorted = [...r.dice].sort((a, b) => b - a);
    assert.equal(r.dropped[0], sorted[3]);
    assert.equal(r.total, r.kept.reduce((a, b) => a + b, 0));
    assert.ok(r.total >= 3 && r.total <= 18);
  }
});

test('stat pool is six independent 4d6-drop-lowest rolls', () => {
  const pool = rollStatPool('chr_test');
  assert.equal(pool.length, 6);
  for (const r of pool) {
    assert.equal(r.purpose, 'statgen');
    assert.equal(r.characterId, 'chr_test');
    assert.ok(r.total >= 3 && r.total <= 18);
  }
});

test('nat 20 crits and nat 1 fumbles regardless of AC', () => {
  let sawCrit = false;
  let sawFumble = false;
  for (let i = 0; i < RUNS; i++) {
    const r = rollAttack(5, 30); // AC 30 — unreachable except by a nat 20
    if (r.natural === 20) {
      assert.equal(r.outcome, 'crit');
      sawCrit = true;
    } else if (r.natural === 1) {
      assert.equal(r.outcome, 'fumble');
      sawFumble = true;
    } else {
      assert.equal(r.outcome, 'miss');
    }
  }
  assert.ok(sawCrit && sawFumble, 'expected both a nat 20 and a nat 1 across 2000 attacks');
});

test('nat 1 fumbles even when the total would have hit', () => {
  for (let i = 0; i < RUNS; i++) {
    const r = rollAttack(20, 5); // +20 vs AC 5: total always beats AC
    if (r.natural === 1) {
      assert.equal(r.outcome, 'fumble', 'a nat 1 is an automatic miss (§1.3)');
      return;
    }
  }
  assert.fail('expected at least one nat 1 across 2000 attacks');
});

test('checks and saves ignore nat 20 and nat 1 (§1.3)', () => {
  let sawNat20Failure = false;
  let sawNat1Success = false;
  for (let i = 0; i < RUNS; i++) {
    const hard = rollCheck(-5, 30);
    if (hard.natural === 20) {
      assert.equal(hard.outcome, 'failure', 'a nat 20 on a check is not an auto-success');
      sawNat20Failure = true;
    }
    const easy = rollCheck(5, 2);
    if (easy.natural === 1) {
      assert.equal(easy.outcome, 'success', 'a nat 1 on a check is not an auto-failure');
      sawNat1Success = true;
    }
  }
  assert.ok(sawNat20Failure && sawNat1Success);
});

test('crit damage doubles the dice but not the modifier', () => {
  for (let i = 0; i < 200; i++) {
    const normal = rollDamage('1d8', 3);
    assert.equal(normal.dice.length, 1);
    assert.equal(normal.modifier, 3);

    const crit = rollDamage('1d8', 3, { crit: true });
    assert.equal(crit.dice.length, 2, 'dice are rolled twice');
    assert.equal(crit.modifier, 3, 'the modifier is added once');
    assert.equal(crit.total, crit.kept.reduce((a, b) => a + b, 0) + 3);
    assert.equal(crit.notation, '2d8+3');
  }
});

test('crit damage folds a notation modifier in exactly once', () => {
  const crit = rollDamage('2d8+3', 0, { crit: true });
  assert.equal(crit.dice.length, 4);
  assert.equal(crit.modifier, 3);
});

test('every roll carries the audit fields the schema requires (§9 rolls table)', () => {
  const r = rollAttack(4, 13, { purpose: 'attack:bloatrat_1', characterId: 'chr_1' });
  for (const field of ['id', 'notation', 'dice', 'modifier', 'total', 'purpose', 'source']) {
    assert.ok(r[field] !== undefined, `missing ${field}`);
  }
  assert.equal(r.source, 'server');
  assert.equal(r.verified, true);
  assert.equal(r.purpose, 'attack:bloatrat_1');
  assert.equal(r.characterId, 'chr_1');
  assert.ok(!Number.isNaN(Date.parse(r.createdAt)));
});

test('manual rolls are flagged unverified', () => {
  const r = roll('1d20', { modifier: 2, source: 'manual', kind: 'attack', vs: 10 });
  assert.equal(r.source, 'manual');
  assert.equal(r.verified, false);
  assert.match(formatRoll(r), /UNVERIFIED/);
});

test('formatRoll shows the full math the player is promised (§12)', () => {
  const r = {
    notation: '1d20+4',
    dice: [17],
    kept: [17],
    dropped: [],
    modifier: 4,
    total: 21,
    vs: 13,
    vsLabel: 'AC',
    outcome: 'hit',
    advantage: 'none',
    verified: true,
  };
  assert.equal(formatRoll(r), '1d20+4 → [17]+4 = 21 vs AC 13 — HIT');
});

test('formatRoll shows dropped dice rather than hiding them', () => {
  const r = {
    notation: '4d6',
    dice: [6, 5, 4, 1],
    kept: [6, 5, 4],
    dropped: [1],
    modifier: 0,
    total: 15,
    vs: null,
    vsLabel: 'DC',
    outcome: null,
    advantage: 'none',
    verified: true,
  };
  assert.equal(formatRoll(r), '4d6 → [6, 5, 4] (dropped 1) = 15');
});
