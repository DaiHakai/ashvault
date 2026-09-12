import { GameSession } from '../server/game.js';
import { getWeapon } from '../server/content.js';

function mk(w, b) {
  const s = new GameSession();
  const pool = s.publicStatPool();
  const pri = getWeapon(w).primary;
  const order = [pri, 'con', ...['str','dex','con','int','wis','cha'].filter(a => a !== pri && a !== 'con')];
  const rank = pool.map((p,i)=>({i,total:p.total})).sort((a,b)=>b.total-a.total);
  const asg = {}; order.forEach((a,n)=>asg[a]=rank[n].i);
  s.beginGame({ name:'Sim', weaponId:w, backgroundId:b, assignment:asg });
  s.takeRecent();
  return s;
}

/** A competent-but-not-perfect bot: heal when low, use the signature, else swing. */
function run(w, b) {
  const s = mk(w, b);
  for (let step = 0; step < 700; step++) {
    if (s.state !== 'playing') break;
    const snap = s.snapshot();
    if (snap.character?.hubUnlocked) return { win: true, room: 'done' };
    const e = snap.encounter;

    if (e && e.yourTurn) {
      const c = s.character;
      const low = c.hp / Math.max(1, c.hpMax) < 0.45;
      if (e.actionUsed) { s.command('pass'); continue; }
      if (low && snap.character.inventory.some(i => /Draught|Elixir/.test(i))) {
        s.command('use draught'); continue;
      }
      const res = c.resource?.current ?? 0;
      const lvl = c.level;
      // Only reach for an ability the character has actually learned — a
      // refused ability costs no turn, so a bot that guesses wrong loops
      // forever and dies without ever swinging.
      if (w === 'gravebell') {
        // `thrall` stays in the snapshot after it falls, so test its HP, not its
        // presence — otherwise the bot raises once per fight and never again.
        const standing = e.thrall && e.thrall.hp > 0;
        // Just try it whenever nothing of ours is standing — the engine refuses
        // when there is no body, and a refusal costs no turn. Gating on a dead
        // enemy meant the carried opening body was never used at all.
        if (res > 0 && !standing) {
          const before = c.resource.current;
          s.command('ability raise thrall');
          if (c.resource.current < before) continue;   // it worked
        }
        if (res > 0 && lvl >= 2) { s.command('ability siphon'); continue; }
      }
      if (res > 0 && w === 'staff') { s.command('ability cinderbolt'); continue; }
      if (low && res > 0 && w === 'lantern') { s.command('ability kindle'); continue; }
      s.command('attack');
      continue;
    }
    if (e) { s.command('pass'); continue; }

    const room = snap.room;
    if (!room) break;
    if (room.shrine && !room.shrineUsed && s.character.hp < s.character.hpMax * 0.8) { s.command('rest'); continue; }
    if (room.searchable && room.id !== 'fungal_gallery') { s.command('search'); continue; }
    const pref = ['down','north','east','west','south','up'];
    const exit = pref.find(d => room.exits.includes(d));
    if (!exit) break;
    s.command(exit);
  }
  return { win: false, room: s.deathRecord?.room ?? s.roomId ?? '?' };
}

const N = Number(process.argv[2] ?? 200);
const weapons = process.argv[3] ? [process.argv[3]] : ['longsword','warhammer','longbow','staff','lantern','gravebell'];
for (const w of weapons) {
  let wins = 0; const deaths = {};
  for (let i = 0; i < N; i++) {
    const r = run(w, 'gravedigger');
    if (r.win) wins++; else deaths[r.room] = (deaths[r.room] ?? 0) + 1;
  }
  const top = Object.entries(deaths).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}:${v}`).join(' ');
  console.log(String(w).padEnd(11), String(Math.round(wins/N*100)+'%').padStart(4), ' died mostly:', top);
}
