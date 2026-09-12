import { GameSession } from '../server/game.js';
import { getWeapon } from '../server/content.js';

function mk(w) {
  const s = new GameSession(); const pool = s.publicStatPool();
  const pri = getWeapon(w).primary;
  const order = [pri,'con',...['str','dex','con','int','wis','cha'].filter(a=>a!==pri&&a!=='con')];
  const rank = pool.map((p,i)=>({i,total:p.total})).sort((a,b)=>b.total-a.total);
  const asg = {}; order.forEach((a,n)=>asg[a]=rank[n].i);
  s.beginGame({ name:'S', weaponId:w, backgroundId:'gravedigger', assignment:asg });
  s.takeRecent();
  // Arrives at the Crypt as a level-4 Maugrim-killer: full HP, the Seal equipped.
  s.character.level = 4; s.character.xp = 410;
  s.character.hpMax = 34; s.character.hp = 34;
  if (s.character.resource) { s.character.resource.max = 8; s.character.resource.current = 8; }
  return s;
}

/** One turn of competent play — the bot must be able to use the kit it is testing. */
function act(s, w) {
  const e = s.snapshot().encounter;
  if (!e) return;
  if (e.actionUsed) { s.command('pass'); return; }
  const c = s.character;
  const res = c.resource?.current ?? 0;
  const low = c.hp / Math.max(1, c.hpMax) < 0.5;
  if (low && s.snapshot().character.inventory.some((i) => /Draught|Elixir/.test(i.name))) {
    const before = c.hp; s.command('use draught'); if (c.hp > before) return;
  }
  if (w === 'gravebell' && res > 0) {
    const standing = e.thrall && e.thrall.hp > 0;
    if (!standing) { const b = c.resource.current; s.command('ability raise thrall'); if (c.resource.current < b) return; }
    if (c.level >= 2) { const b = c.resource.current; s.command('ability siphon'); if (c.resource.current < b) return; }
  }
  if (w === 'lantern' && low && res > 0) { const b = c.resource.current; s.command('ability kindle'); if (c.resource.current < b) return; }
  if (w === 'staff' && res > 0) { const b = c.resource.current; s.command('ability cinderbolt'); if (c.resource.current < b) return; }
  s.command('attack');
}

const N = Number(process.argv[2] ?? 200);
for (const w of (process.argv[3] ? [process.argv[3]] : ['longsword','lantern','gravebell'])) {
  for (const path of ['west','east']) {
    let win = 0; const died = {};
    for (let n = 0; n < N; n++) {
      const s = mk(w); s.enterRoom('crypt_entrance');
      for (const step of ['down', path, 'down', 'north']) {
        for (let i=0;i<300 && s.fighting();i++) act(s, w);
        if (s.state !== 'playing') break;
        if (s.roomId === 'sanctum_antechamber') s.command('rest');
        s.command(step);
      }
      for (let i=0;i<400 && s.fighting();i++) act(s, w);
      if (s.state==='playing' && s.roomId==='wardens_sanctum' && !s.fighting()) win++;
      else { const r = s.deathRecord?.room ?? s.roomId; died[r]=(died[r]??0)+1; }
    }
    const top = Object.entries(died).sort((a,b)=>b[1]-a[1]).slice(0,2).map(([k,v])=>`${k}:${v}`).join(' ');
    console.log(`${w.padEnd(10)} ${path.padEnd(5)} ${String(Math.round(win/N*100)+'%').padStart(4)}  ${top}`);
  }
}
