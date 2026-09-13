import test from 'node:test';
import assert from 'node:assert/strict';
import { GameSession } from '../server/game.js';

test('a serialized run restores its character and current room', () => {
  const game = new GameSession();
  const pool = game.publicStatPool();
  game.beginGame({
    name: 'Pocket Tester',
    weaponId: 'longsword',
    backgroundId: 'gravedigger',
    assignment: { str: 0, dex: 1, con: 2, int: 3, wis: 4, cha: 5 },
  });
  const saved = game.saveState();
  saved.entries = saved.entries.slice(-40);
  const restored = GameSession.restore(JSON.parse(JSON.stringify(saved)));

  assert.equal(restored.character.name, 'Pocket Tester');
  assert.equal(restored.roomId, game.roomId);
  assert.equal(restored.snapshot().character.title, game.snapshot().character.title);
  assert.equal(pool.length, 6);
});
