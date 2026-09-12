// Combat. GAME_DESIGN.md §4, plus Maugrim's three phases from §5.4.
//
// Turn-based and room-scoped. There is no grid; range is a binary melee/ranged
// tag. One player for Phase 1, but the initiative order is a general list of
// actors so Phase 4 can drop more players into it without a rewrite.

import { roll, rollAttack, rollDamage, formatRoll } from './dice.js';
import { getEnemy, getWeapon } from './content.js';
import {
  abilityMod,
  saveMod,
  spellSaveDc,
  proficiencyBonus,
  levelForXp,
  effectiveMaxHp,
  formatMod,
} from './rules.js';
import {
  weaponOf,
  weaponAttackBonus,
  weaponDamageMod,
  armourClass,
  knownAbilities,
  hasAbility,
  damage as applyDamage,
  heal as applyHeal,
  drainMaxHp,
  spendResource,
  levelUp,
  saveItemBonus,
  hasTrait,
  trait,
  traitAmount,
  takePendingAdvantage,
} from './character.js';

let enemyUid = 0;

export class Encounter {
  /**
   * @param room        room definition from content
   * @param character   the live character object (mutated in place)
   * @param log         (kind, text, roll?) => void
   * @param savedHp     array of HP values from a previous flee, positionally matched
   */
  constructor({ room, character, log, savedHp = null }) {
    this.room = room;
    this.character = character;
    this.log = log;

    this.enemies = room.enemies.map((id, i) => this.buildEnemy(id, i, savedHp?.[i]));
    this.order = [];
    this.turnIndex = 0;
    this.round = 1;
    this.playerTurnCount = 0;
    this.lastActorUid = null;

    this.over = false;
    this.result = null; // 'victory' | 'death' | 'fled'

    // The Necromancer's Thrall (§2.10). At most one exists at a time, it takes
    // a slot in the initiative order like anything else, and while it stands
    // the room attacks it instead of you — that is the whole bargain of the
    // weapon: you spend an action to buy a body to stand behind.
    this.thrall = null;
    /** The last enemy destroyed this fight, and therefore what Raise Thrall raises. */
    this.lastCorpse = null;

    // A Necromancer arrives with a body already following them. Without this the
    // whole kit is reactive — you cannot raise until you have killed, and against
    // a room of three you are dead before you make the first corpse. Measured: the
    // weapon does not clear the dungeon at all without an opening body.
    const raise = knownAbilities(character).find((a) => a.id === 'raise_thrall');
    if (raise?.carried) {
      const c = raise.carried;
      this.lastCorpse = {
        id: 'carrion_servant',
        name: c.name,
        hpMax: c.hpBase + c.hpPerLevel * character.level,
        ac: c.ac,
        attackBonus: c.attackBase + c.attackPerLevel * character.level,
        damage: c.damage,
        carried: true,
      };
    }

    this.player = {
      actionUsed: false,
      bonusUsed: false,
      defendingUntilTurn: null,
      emberwallUntilTurn: null,
      hidden: false,
      markedUid: null,
      saveAdvantage: false,
      riposteUsed: false,
      skipNextAction: false,
      onPlinth: false,
      // Background traits with a once-per-encounter charge.
      escortUsed: false,
      slipUsed: false,
      instinctUsed: false,
      calledInUid: null,
    };
  }

  buildEnemy(id, index, savedHp) {
    const def = getEnemy(id);
    const sameKind = this.enemiesOfKindSoFar ?? {};
    sameKind[id] = (sameKind[id] ?? 0) + 1;
    this.enemiesOfKindSoFar = sameKind;
    const total = this.room.enemies.filter((e) => e === id).length;

    return {
      uid: `e${++enemyUid}`,
      id,
      def,
      name: def.name,
      label: total > 1 ? `${def.name} ${sameKind[id]}` : def.name,
      hp: savedHp ?? def.hp,
      hpMax: def.hp,
      ac: def.ac,
      attackBonus: def.attackBonus,
      damage: def.damage,
      initiative: def.initiative,
      xp: def.xp,
      boss: Boolean(def.boss),
      lifesteal: def.lifesteal ?? 0,
      burning: null,
      bossTurns: 0,
      phase: def.boss ? 1 : null,
      index,
    };
  }

  // ------------------------------------------------------------- lifecycle

  start() {
    this.log('danger', describeEnemies(this.enemies));

    // A boss opens in phase 1, so no transition ever fires for it — announce it
    // here or its opening line is content the player never sees.
    const boss = this.enemies.find((e) => e.boss);
    if (boss) {
      const opening = boss.def.phases[boss.phase - 1];
      this.log('level', `— ${opening.name} —`);
      this.log('danger', opening.enterText);
    }

    for (const e of this.enemies) {
      if (e.hp < e.hpMax) {
        this.log('narration', `${e.label} still carries the wounds you left it. (${e.hp}/${e.hpMax} HP)`);
      }
    }

    // Disgraced Scholar's Read the Room: name what everyone else has to learn
    // the expensive way. This is the one trait that fixes a teaching problem —
    // Maugrim's fire resistance used to cost the player their Embers to find.
    if (hasTrait(this.character, 'revealTraits')) {
      for (const e of this.living()) {
        const notes = [];
        if (e.def.trait?.text) notes.push(e.def.trait.text);
        for (const phase of e.def.phases ?? []) {
          if (phase.resistances?.length) notes.push(`${phase.name}: resists ${phase.resistances.join(', ')}`);
          if (phase.meleePenalty) notes.push(`${phase.name}: melee suffers unless you take the plinth`);
          if (phase.drowningSong) notes.push(`${phase.name}: drains maximum HP on a failed CON save`);
        }
        if (notes.length) this.log('good', `You have read about this. ${e.label} — ${notes.join('; ')}`);
      }
    }

    const dexMod = abilityMod(this.character.abilities.dex) + traitAmount(this.character, 'initiative');
    const playerRoll = roll('1d20', {
      modifier: dexMod,
      purpose: 'initiative:player',
      characterId: this.character.id,
    });
    this.log('roll', `Initiative — ${this.character.name}: ${formatRoll(playerRoll)}`, playerRoll);

    const actors = [
      { kind: 'player', uid: 'player', init: playerRoll.total, tiebreak: dexMod },
    ];
    for (const e of this.enemies) {
      const r = roll('1d20', { modifier: e.initiative, purpose: `initiative:${e.id}` });
      this.log('roll', `Initiative — ${e.label}: ${formatRoll(r)}`, r);
      actors.push({ kind: 'enemy', uid: e.uid, init: r.total, tiebreak: e.initiative });
    }

    actors.sort((a, b) => b.init - a.init || b.tiebreak - a.tiebreak);
    this.order = actors;
    this.turnIndex = 0;
    this.log('system', `Order: ${actors.map((a) => this.actorName(a)).join(' → ')}`);

    this.resume();
  }

  /** Re-roll initiative — the Caravan Guard's signal horn (§3). */
  rerollInitiative() {
    const dexMod = abilityMod(this.character.abilities.dex);
    for (const actor of this.order) {
      const mod = actor.kind === 'player' ? dexMod : this.enemyByUid(actor.uid).initiative;
      const r = roll('1d20', { modifier: mod, purpose: 'initiative:reroll' });
      actor.init = r.total;
      this.log('roll', `Initiative — ${this.actorName(actor)}: ${formatRoll(r)}`, r);
    }
    this.order.sort((a, b) => b.init - a.init || b.tiebreak - a.tiebreak);
    this.turnIndex = this.order.findIndex((a) => a.kind === 'player');
    this.log('system', `Order: ${this.order.map((a) => this.actorName(a)).join(' → ')}`);
  }

  actorName(actor) {
    if (actor.kind === 'player') return this.character.name;
    if (actor.kind === 'thrall') return this.thrall?.label ?? 'Thrall';
    return this.enemyByUid(actor.uid).label;
  }

  /** A living Thrall soaks every attack in the room (§2.10). */
  thrallStanding() {
    return this.thrall && this.thrall.hp > 0 ? this.thrall : null;
  }

  enemyByUid(uid) {
    return this.enemies.find((e) => e.uid === uid) ?? null;
  }

  living() {
    return this.enemies.filter((e) => e.hp > 0);
  }

  currentActor() {
    return this.order[this.turnIndex];
  }

  isPlayerTurn() {
    return !this.over && this.currentActor()?.kind === 'player';
  }

  advanceTurn() {
    if (this.over) return;
    for (let guard = 0; guard < 64; guard++) {
      this.turnIndex += 1;
      if (this.turnIndex >= this.order.length) {
        this.turnIndex = 0;
        this.round += 1;
      }
      const actor = this.currentActor();
      if (actor.kind === 'player') return;
      if (actor.kind === 'thrall') {
        if (this.thrallStanding()) return;
        continue; // a fallen Thrall keeps its slot but never acts again
      }
      const enemy = this.enemyByUid(actor.uid);
      if (enemy && enemy.hp > 0) return;
    }
  }

  /** Run enemy and Thrall turns until it is the player's turn again. */
  resume() {
    while (!this.over && this.currentActor()?.kind !== 'player') {
      const actor = this.currentActor();
      if (actor.kind === 'thrall') {
        if (this.thrallStanding()) this.thrallTurn();
      } else {
        const enemy = this.enemyByUid(actor.uid);
        if (enemy && enemy.hp > 0) this.enemyTurn(enemy);
      }
      if (this.over) return;
      this.advanceTurn();
    }
    if (!this.over) this.beginPlayerTurn();
  }

  beginPlayerTurn() {
    this.playerTurnCount += 1;
    const p = this.player;

    if (p.defendingUntilTurn !== null && p.defendingUntilTurn < this.playerTurnCount) {
      p.defendingUntilTurn = null;
    }
    if (p.emberwallUntilTurn !== null && p.emberwallUntilTurn < this.playerTurnCount) {
      p.emberwallUntilTurn = null;
      this.log('narration', 'The emberwall gutters out.');
    }

    p.actionUsed = false;
    p.bonusUsed = false;

    if (p.skipNextAction) {
      p.skipNextAction = false;
      p.actionUsed = true;
      this.log(
        'danger',
        'The undertow still has you — no action this turn. A bonus action, if you have one, then PASS.'
      );
    }
  }

  endPlayerTurn() {
    if (this.over) return;
    this.lastActorUid = 'player';
    this.advanceTurn();
    this.resume();
  }

  // ------------------------------------------------------------ player acts

  /** Consume the action, used by non-combat-module actions such as USE. */
  consumeAction() {
    this.player.actionUsed = true;
  }

  playerAttack(enemy) {
    const p = this.player;
    if (p.actionUsed) return fail('You have already acted this turn. PASS to end it.');

    const weapon = weaponOf(this.character);
    const result = this.resolvePlayerAttack(enemy, weapon);
    p.actionUsed = true;
    if (!this.over) this.endPlayerTurn();
    return { ok: true, ...result };
  }

  resolvePlayerAttack(enemy, weapon, { free = false } = {}) {
    const p = this.player;
    const meleePenalty = this.meleePenaltyFor(weapon);
    const advantage = this.attackAdvantageAgainst(enemy)
      ? 'advantage'
      : takePendingAdvantage(this.character);

    if (meleePenalty) {
      this.log('narration', 'The flood drags at every swing — you are fighting the water as much as the warden.');
    }

    const bonus = weaponAttackBonus(this.character) + meleePenalty;
    const atk = rollAttack(bonus, enemy.ac, {
      advantage,
      purpose: `attack:${enemy.id}`,
      characterId: this.character.id,
    });
    this.log('roll', `${free ? 'Riposte' : 'Attack'} on ${enemy.label} — ${formatRoll(atk)}`, atk);

    if (atk.outcome === 'miss' || atk.outcome === 'fumble') {
      this.log('narration', atk.outcome === 'fumble' ? 'A natural 1. The blow goes wide of everything.' : `You miss ${enemy.label}.`);
      return { hit: false };
    }

    const crit = atk.outcome === 'crit';
    const dmg = rollDamage(weapon.damage, weaponDamageMod(this.character), {
      crit,
      purpose: `damage:${enemy.id}`,
      characterId: this.character.id,
    });
    let total = dmg.total;
    this.log('roll', `${crit ? 'CRITICAL damage' : 'Damage'} — ${formatRoll(dmg)}`, dmg);

    if (p.hidden) {
      const sneak = rollDamage('2d6', 0, { purpose: 'damage:fade', characterId: this.character.id });
      total += sneak.total;
      this.log('roll', `Out of nowhere — ${formatRoll(sneak)}`, sneak);
      p.hidden = false;
      this.log('narration', 'You are seen again.');
    }

    // Gravedigger's Deadweight: you know exactly how much a body weighs.
    const deadweight = trait(this.character, 'damageVsWounded');
    if (deadweight && enemy.hp <= enemy.hpMax / 2) {
      total += deadweight.amount;
      this.log('good', `${deadweight.name} — it is already going down. +${deadweight.amount}.`);
    }

    // Debt Collector's Call It In: the named debt comes due.
    if (p.calledInUid === enemy.uid) {
      const called = trait(this.character, 'nextHitBonus');
      const extra = rollDamage(called.damage, 0, { purpose: 'damage:call_in' });
      total += extra.total;
      this.log('roll', `The debt comes due — ${formatRoll(extra)}`, extra);
      p.calledInUid = null;
    }

    this.damageEnemy(enemy, total, { fromPlayer: true });
    return { hit: true, crit, damage: total };
  }

  attackAdvantageAgainst(enemy) {
    return this.player.markedUid === enemy.uid || this.player.hidden;
  }

  /** §5.4 phase 2/3 — melee suffers unless the player is up on the plinth. */
  meleePenaltyFor(weapon) {
    const boss = this.enemies.find((e) => e.boss && e.hp > 0);
    if (!boss || boss.phase < 2) return 0;
    if (weapon.range === 'ranged') return 0;
    if (this.player.onPlinth) return 0;
    if (hasTrait(this.character, 'ignoreWater')) return 0; // Ferryman's Slack Water
    const phaseDef = boss.def.phases[boss.phase - 1];
    return phaseDef.meleePenalty ?? 0;
  }

  damageEnemy(enemy, amount, { fromPlayer = false, damageType = null } = {}) {
    let dealt = Math.max(0, Math.floor(amount));
    const phaseDef = enemy.boss ? enemy.def.phases[enemy.phase - 1] : null;
    if (damageType && phaseDef?.resistances?.includes(damageType)) {
      dealt = Math.floor(dealt / 2);
      this.log('narration', `${enemy.label} is resistant to ${damageType} — the damage is halved.`);
    }

    enemy.hp = Math.max(0, enemy.hp - dealt);
    this.log('damage', `${enemy.label} takes ${dealt}. (${enemy.hp}/${enemy.hpMax} HP)`);

    if (enemy.boss && enemy.hp > 0) this.checkBossPhase(enemy);
    if (enemy.hp === 0) this.killEnemy(enemy, { byPlayer: fromPlayer });
  }

  killEnemy(enemy, { byPlayer }) {
    this.log('good', `${enemy.label} is destroyed.`);

    // Remember the body — Raise Thrall needs something to raise (§2.10).
    this.lastCorpse = {
      id: enemy.id, name: enemy.name, hpMax: enemy.hpMax,
      ac: enemy.ac, attackBonus: enemy.attackBonus, damage: enemy.damage,
    };

    if (enemy.def.onDeath?.kind === 'burst') {
      const od = enemy.def.onDeath;
      this.log('danger', od.text);
      const save = this.playerSave(od.saveAbility, od.dc, `save:burst:${enemy.id}`);
      if (save.outcome === 'failure') {
        const burst = rollDamage(od.damage, 0, { purpose: 'damage:burst' });
        this.log('roll', `Burst — ${formatRoll(burst)}`, burst);
        this.hurtPlayer(burst.total, `${enemy.name} (burst)`);
        if (this.over) return;
      } else {
        this.log('good', 'You are clear of it.');
      }
    }

    this.awardXp(enemy);

    if (this.player.markedUid === enemy.uid) {
      this.player.markedUid = null;
      this.log('narration', 'Your mark dies with it.');
    }

    if (this.living().length === 0) {
      this.over = true;
      this.result = 'victory';
      this.log('good', 'The room is yours.');
      return;
    }

    // Blade level 3 — Cleave (§2.1).
    if (byPlayer && hasAbility(this.character, 'cleave')) {
      const next = this.living()[0];
      if (next) {
        this.log('good', `Cleave — the swing carries on into ${next.label}.`);
        this.resolvePlayerAttack(next, weaponOf(this.character), { free: true });
      }
    }
  }

  awardXp(enemy) {
    const before = this.character.level;
    this.character.xp += enemy.xp;
    this.log('good', `+${enemy.xp} XP. (${this.character.xp} total)`);

    while (levelForXp(this.character.xp) > this.character.level) {
      const up = levelUp(this.character);
      this.log('level', `${this.character.name} reaches level ${this.character.level}.`);
      this.log('roll', `Hit die — ${formatRoll(up.hpRoll)}`, up.hpRoll);
      this.log('good', `Maximum HP +${up.hpGained}. (${this.character.hp}/${effectiveMaxHp(this.character)})`);
      if (up.resourceGained > 0) {
        this.log('good', `${this.character.resource.name} +${up.resourceGained}. (${this.character.resource.current}/${this.character.resource.max})`);
      }
      for (const ability of up.unlocked) {
        this.log('level', `New ability — ${ability.name}: ${ability.text}`);
      }
    }
    return this.character.level > before;
  }

  // ------------------------------------------------------------- abilities

  playerAbility(ability, enemy) {
    const p = this.player;
    const weaponDef = getWeapon(this.character.weaponId);

    if (ability.type === 'action' && p.actionUsed) {
      return fail('You have already acted this turn. PASS to end it.');
    }
    if (ability.type === 'bonus' && p.bonusUsed) {
      return fail('You have already used your bonus action this turn.');
    }
    if (ability.type === 'passive') {
      return fail(`${ability.name} is always on — there is nothing to activate.`);
    }
    if (ability.uses === 'encounter' && p.riposteUsed && ability.id === 'riposte') {
      return fail(`${ability.name} triggers on its own when an enemy misses you.`);
    }
    if (ability.auto) {
      return fail(`${ability.name} triggers on its own — you do not spend a turn on it.`);
    }
    if (ability.uses === 'rest' && this.character.restUses[ability.id]) {
      return fail(`${ability.name} is spent until you rest.`);
    }
    if (ability.uses === 'encounter' && ability.id === 'call_in' && p.calledInUid) {
      return fail(`${ability.name} is spent for this encounter.`);
    }
    if (ability.id === 'last_breath') {
      return fail('Last Breath can only be spent on someone else, and you are alone down here.');
    }
    // Check affordability here, but do not take the charge yet. Several abilities
    // can still be refused after this point — no target, no body to raise — and
    // a refusal that silently costs a charge is the worst kind of bug to hit in
    // a permadeath game. The charge is taken in consume(), at the moment the
    // ability actually commits.
    if (ability.cost && (this.character.resource?.current ?? 0) < ability.cost) {
      return fail(`Not enough ${weaponDef.resource.name}. (${this.character.resource.current}/${this.character.resource.max})`);
    }
    if (ability.targets === 'enemy' && !enemy) {
      return fail(`${ability.name} needs a target.`);
    }

    const consume = () => {
      if (ability.cost) spendResource(this.character, ability.cost);
      if (ability.type === 'action') p.actionUsed = true;
      if (ability.type === 'bonus') p.bonusUsed = true;
      if (ability.uses === 'rest') this.character.restUses[ability.id] = true;
    };

    switch (ability.id) {
      case 'mark': {
        p.markedUid = enemy.uid;
        this.log('good', `You mark ${enemy.label}. Your attacks against it have advantage.`);
        return { ok: true, endsTurn: false };
      }

      case 'second_wind': {
        consume();
        const r = rollDamage(ability.heal, this.character.level, {
          purpose: 'heal:second_wind',
          characterId: this.character.id,
        });
        const healed = applyHeal(this.character, r.total);
        this.log('roll', `Second Wind — ${formatRoll(r)}`, r);
        this.log('good', `You recover ${healed} HP. (${this.character.hp}/${effectiveMaxHp(this.character)})`);
        return { ok: true, endsTurn: false };
      }

      case 'fade': {
        consume();
        const r = roll('1d20', {
          modifier: abilityMod(this.character.abilities.dex),
          kind: 'check',
          vs: ability.dc,
          purpose: 'check:fade',
          characterId: this.character.id,
        });
        this.log('roll', `Fade — ${formatRoll(r)}`, r);
        if (r.outcome === 'success') {
          p.hidden = true;
          this.log('good', 'You are not where you were. Your next attack lands from nowhere.');
        } else {
          this.log('danger', 'There is nowhere in this room to not be.');
        }
        return { ok: true, endsTurn: true };
      }

      case 'cinderbolt': {
        consume();
        const atk = rollAttack(
          castingAttackBonus(this.character, 'int'),
          enemy.ac,
          {
            advantage: this.attackAdvantageAgainst(enemy) ? 'advantage' : 'none',
            purpose: `attack:cinderbolt:${enemy.id}`,
            characterId: this.character.id,
          }
        );
        this.log('roll', `Cinderbolt at ${enemy.label} — ${formatRoll(atk)}`, atk);
        if (atk.outcome === 'miss' || atk.outcome === 'fumble') {
          this.log('narration', 'The bolt hisses past and dies against wet stone.');
          return { ok: true, endsTurn: true };
        }
        const crit = atk.outcome === 'crit';
        // Adds the casting modifier, exactly as a weapon adds its ability mod.
        // Without it a 1-Ember Cinderbolt was weaker than swinging the free rod.
        const dmg = rollDamage(ability.damage, abilityMod(this.character.abilities.int), {
          crit,
          purpose: `damage:cinderbolt`,
          characterId: this.character.id,
        });
        this.log('roll', `${crit ? 'CRITICAL fire' : 'Fire'} — ${formatRoll(dmg)}`, dmg);
        if (crit) {
          enemy.burning = { dice: ability.burn, rounds: ability.burnRounds };
          this.log('danger', `${enemy.label} is burning.`);
        }
        this.damageEnemy(enemy, dmg.total, { fromPlayer: true, damageType: ability.damageType });
        return { ok: true, endsTurn: true };
      }

      case 'emberwall': {
        consume();
        p.emberwallUntilTurn = this.playerTurnCount;
        this.log('good', 'A sheet of standing fire rises around you. +2 AC until your next turn.');
        return { ok: true, endsTurn: true };
      }

      case 'raise_thrall': {
        if (this.thrallStanding()) {
          return fail(`${this.thrall.label} is already up. You can only hold one at a time.`);
        }
        if (!this.lastCorpse) {
          return fail('Nothing here has died yet. Raise Thrall needs a body.');
        }
        consume();
        this.raiseThrall();
        return { ok: true, endsTurn: true };
      }

      case 'siphon': {
        if (!enemy) return fail('Siphon what? Name a target.');
        consume();
        const atk = rollAttack(castingAttackBonus(this.character, 'cha'), enemy.ac, {
          advantage: this.attackAdvantageAgainst(enemy),
          purpose: `attack:siphon:${enemy.id}`,
        });
        this.log('roll', `Siphon at ${enemy.label} — ${formatRoll(atk)}`, atk);
        if (atk.outcome === 'miss' || atk.outcome === 'fumble') {
          this.log('danger', 'The note goes wide and takes nothing back with it.');
          return { ok: true, endsTurn: true };
        }
        const dmg = rollDamage(ability.damage, 0, {
          crit: atk.outcome === 'crit',
          purpose: 'damage:siphon',
        });
        this.log('roll', `Necrotic — ${formatRoll(dmg)}`, dmg);
        this.damageEnemy(enemy, dmg.total, { fromPlayer: true, damageType: ability.damageType });

        // Heal for half of what it dealt — the Warden's Devour, run backwards.
        const healed = Math.max(1, Math.floor(dmg.total / 2));
        const before = this.character.hp;
        this.character.hp = Math.min(effectiveMaxHp(this.character), this.character.hp + healed);
        const gained = this.character.hp - before;
        this.log('good', gained > 0
          ? `Half of it comes back to you. +${gained} HP.`
          : 'Half of it comes back to you, and there is nowhere for it to go.');
        return { ok: true, endsTurn: true };
      }

      case 'detonate': {
        consume();
        const dc = spellSaveDc(this.character, 'int');
        this.log('danger', `You let go of all of it at once. DEX save, DC ${dc}.`);
        const targets = this.living();
        for (const target of targets) {
          const dmg = rollDamage(ability.damage, 0, { purpose: 'damage:detonate' });
          // Enemies have no save block of their own; their initiative bonus is
          // the DEX-derived number the content actually defines, so it stands in.
          const save = roll('1d20', {
            modifier: target.initiative,
            kind: 'save',
            vs: dc,
            purpose: `save:detonate:${target.id}`,
          });
          this.log('roll', `${target.label} — ${formatRoll(save)}`, save);
          const dealt = save.outcome === 'success' ? Math.floor(dmg.total / 2) : dmg.total;
          this.log('roll', `Detonation — ${formatRoll(dmg)}${save.outcome === 'success' ? ' (halved)' : ''}`, dmg);
          this.damageEnemy(target, dealt, { fromPlayer: true, damageType: ability.damageType });
          if (this.over) break;
        }
        return { ok: true, endsTurn: true };
      }

      case 'kindle': {
        consume();
        const r = rollDamage(ability.heal, abilityMod(this.character.abilities.wis), {
          purpose: 'heal:kindle',
          characterId: this.character.id,
        });
        const healed = applyHeal(this.character, r.total);
        this.log('roll', `Kindle — ${formatRoll(r)}`, r);
        this.log('good', `You recover ${healed} HP. (${this.character.hp}/${effectiveMaxHp(this.character)})`);
        return { ok: true, endsTurn: true };
      }

      case 'call_in': {
        if (p.calledInUid) return fail('You have already named a debt this encounter.');
        consume();
        p.calledInUid = enemy.uid;
        this.log('good', `You name the debt. ${enemy.label} owes an extra ${ability.damage} on your next hit.`);
        return { ok: true, endsTurn: true };
      }

      case 'warding_light': {
        consume();
        p.saveAdvantage = true;
        this.log('good', 'The lantern steadies. Advantage on your next saving throw.');
        return { ok: true, endsTurn: true };
      }

      default:
        return fail(`${ability.name} does nothing you can use right now.`);
    }
  }

  // ---------------------------------------------------------- other actions

  playerDefend() {
    if (this.player.actionUsed) return fail('You have already acted this turn. PASS to end it.');
    this.player.actionUsed = true;
    this.player.defendingUntilTurn = this.playerTurnCount;
    this.log('good', 'You set your guard. +2 AC until your next turn.');
    this.endPlayerTurn();
    return { ok: true };
  }

  playerPass() {
    this.player.actionUsed = true;
    this.log('narration', 'You hold, and wait.');
    this.endPlayerTurn();
    return { ok: true };
  }

  playerClimb() {
    if (!this.room.plinth) return fail('There is nothing here to climb.');
    if (this.player.onPlinth) return fail('You are already on the plinth.');
    if (this.player.actionUsed) return fail('You have already acted this turn. PASS to end it.');
    this.player.actionUsed = true;
    this.player.onPlinth = true;
    this.log('good', 'You haul yourself onto the plinth, clear of the water.');
    this.endPlayerTurn();
    return { ok: true };
  }

  playerDescend() {
    if (!this.player.onPlinth) return fail('You are not on the plinth.');
    this.player.onPlinth = false;
    this.log('narration', 'You drop back down into the water.');
    return { ok: true, endsTurn: false };
  }

  /** §4.4 — DC 12 DEX, +2 where the room fights you. Failure gives every enemy a free swing. */
  playerFlee() {
    if (this.room.noFlee) {
      return fail('The door is barred behind you. It was barred on the way in. There is no leaving this.');
    }
    if (this.player.actionUsed) return fail('You have already acted this turn. PASS to end it.');

    // Gutter Rat's Slip: the first way out each encounter is always open.
    const slip = trait(this.character, 'freeFlee');
    if (slip && !this.player.slipUsed) {
      this.player.slipUsed = true;
      this.over = true;
      this.result = 'fled';
      this.log('good', `${slip.name} — you are out of the room before anything has decided to stop you.`);
      return { ok: true, fled: true };
    }

    // Ferryman ignores the water; Deserter is simply very good at this.
    const waterBonus = hasTrait(this.character, 'ignoreWater') ? 0 : (this.room.fleeDcBonus ?? 0);

    // The DC belongs to what you are running from, not to fleeing in the
    // abstract — a swollen rat is easy to outrun and a Warren Shrike is not.
    // The hardest thing still standing sets the number.
    const base = Math.max(12, ...this.living().map((e) => e.def.fleeDc ?? 12));
    const dc = base + waterBonus;
    const worst = this.living().reduce((a, b) => ((b.def.fleeDc ?? 12) > (a.def.fleeDc ?? 12) ? b : a), this.living()[0]);
    if (worst && (worst.def.fleeDc ?? 12) > 12) {
      this.log('narration', `${worst.label} is the one that will catch you. DC ${dc}.`);
    }
    if (this.room.fleeDcReason && waterBonus) {
      this.log('narration', `DC ${dc} — ${this.room.fleeDcReason}.`);
    }
    const r = roll('1d20', {
      modifier: abilityMod(this.character.abilities.dex) + traitAmount(this.character, 'fleeBonus'),
      kind: 'check',
      vs: dc,
      purpose: 'check:flee',
      characterId: this.character.id,
    });
    this.log('roll', `Flee — ${formatRoll(r)}`, r);

    if (r.outcome === 'success') {
      this.over = true;
      this.result = 'fled';
      this.log('good', 'You break off and fall back the way you came.');
      return { ok: true, fled: true };
    }

    this.log('danger', 'You turn, and turning is a mistake.');
    for (const enemy of this.living()) {
      this.enemyAttack(enemy, { reason: 'as you turn' });
      if (this.over) return { ok: true, fled: false };
    }
    this.player.actionUsed = true;
    this.endPlayerTurn();
    return { ok: true, fled: false };
  }

  // -------------------------------------------------------------- enemy AI

  enemyTurn(enemy) {
    if (enemy.burning) {
      const r = rollDamage(enemy.burning.dice, 0, { purpose: 'damage:burn' });
      this.log('roll', `${enemy.label} burns — ${formatRoll(r)}`, r);
      this.damageEnemy(enemy, r.total, { fromPlayer: true, damageType: 'fire' });
      enemy.burning.rounds -= 1;
      if (enemy.burning.rounds <= 0) enemy.burning = null;
      if (enemy.hp === 0 || this.over) return;
    }

    if (enemy.boss) return this.bossTurn(enemy);
    this.enemyAttack(enemy);
    this.lastActorUid = enemy.uid;
  }

  /** §5.4 — Drowning Song, then Undertow every third turn, otherwise a swing. */
  bossTurn(boss) {
    boss.bossTurns += 1;
    const phaseDef = boss.def.phases[boss.phase - 1];

    if (phaseDef.drowningSong) {
      const song = phaseDef.drowningSong;
      this.log('danger', song.text);
      const dmg = rollDamage(song.damage, 0, { purpose: 'damage:drowning_song' });
      this.log('roll', `Drowning Song — ${formatRoll(dmg)}`, dmg);
      this.hurtPlayer(dmg.total, boss.name);
      if (this.over) return;

      const save = this.playerSave(song.saveAbility, song.dc, 'save:drowning_song');
      if (save.outcome === 'failure') {
        drainMaxHp(this.character, dmg.total);
        this.log(
          'danger',
          `The water stays in you. Maximum HP down ${dmg.total} for the rest of this run. (${this.character.hp}/${effectiveMaxHp(this.character)})`
        );
      } else {
        this.log('good', 'You cough it back out.');
      }
    }

    if (phaseDef.undertowEvery && boss.bossTurns % phaseDef.undertowEvery === 0) {
      const ut = phaseDef.undertow;
      this.log('danger', ut.text);
      const save = this.playerSave(ut.saveAbility, ut.dc, 'save:undertow');
      if (save.outcome === 'failure') {
        this.player.skipNextAction = true;
        this.log('danger', 'It takes your feet. You lose your action next turn.');
      } else {
        this.log('good', 'You hold your footing.');
      }
      this.lastActorUid = boss.uid;
      return; // Undertow is the turn's action.
    }

    this.enemyAttack(boss);
    this.lastActorUid = boss.uid;
  }

  checkBossPhase(boss) {
    const next = boss.def.phases.find((p) => boss.hp <= p.from && boss.hp >= p.to);
    if (!next || next.index === boss.phase) return;
    boss.phase = next.index;
    this.log('level', `— ${next.name} —`);
    this.log('danger', next.enterText);
    if (next.meleePenalty && !this.player.onPlinth) {
      this.log('narration', 'Melee attacks take a penalty until you CLIMB the plinth.');
    }
  }

  enemyAttack(enemy, { reason = null } = {}) {
    // A standing Thrall is between the room and you (§2.10).
    const thrall = this.thrallStanding();
    if (thrall) {
      const choir = this.choirBonus(enemy);
      const atk = rollAttack(enemy.attackBonus + choir, thrall.ac, {
        purpose: `attack:${enemy.id}:thrall`,
      });
      this.log('roll', `${enemy.label} attacks ${thrall.label} — ${formatRoll(atk)}`, atk);
      if (atk.outcome === 'miss' || atk.outcome === 'fumble') {
        this.log('good', `${enemy.label} misses it.`);
        return;
      }
      const dmg = rollDamage(enemy.damage, 0, {
        crit: atk.outcome === 'crit',
        purpose: `damage:${enemy.id}:thrall`,
      });
      this.log('roll', `Damage — ${formatRoll(dmg)}`, dmg);
      this.hurtThrall(dmg.total, enemy.name);
      return;
    }

    const choirBonus = this.choirBonus(enemy);
    let advantage = this.enemyHasAdvantage(enemy) ? 'advantage' : 'none';

    // Deserter's Survivor's Instinct: you were already moving.
    const instinct = trait(this.character, 'firstAttackDisadvantage');
    if (instinct && !this.player.instinctUsed) {
      this.player.instinctUsed = true;
      advantage = advantage === 'advantage' ? 'none' : 'disadvantage';
      this.log('good', `${instinct.name} — the first swing of the fight finds you already moving.`);
    }

    if (choirBonus > 0) {
      this.log('narration', `The choir carries ${enemy.label}. ${formatMod(choirBonus)} to hit.`);
    }
    if (advantage === 'advantage') {
      this.log('narration', `${enemy.label} takes you exactly when you are busiest.`);
    }

    const ac = this.playerAc();
    const stats = this.statsFor(enemy);
    const atk = rollAttack(stats.attackBonus + choirBonus, ac, {
      advantage,
      purpose: `attack:${enemy.id}:player`,
    });
    const prefix = stats.attackName
      ? `${enemy.label} — ${stats.attackName}`
      : reason ? `${enemy.label} strikes ${reason}` : `${enemy.label} attacks`;
    this.log('roll', `${prefix} — ${formatRoll(atk)}`, atk);

    if (atk.outcome === 'miss' || atk.outcome === 'fumble') {
      this.log('good', `${enemy.label} misses you.`);
      this.tryRiposte(enemy);
      return;
    }

    const crit = atk.outcome === 'crit';
    // The choir buff is to-hit only. Applying it to damage as well made three
    // Choristers spike hard enough to one-round every class but the Blade.
    const dmg = rollDamage(stats.damage, 0, {
      crit,
      purpose: `damage:${enemy.id}:player`,
    });
    this.log('roll', `${crit ? 'CRITICAL damage' : 'Damage'} — ${formatRoll(dmg)}`, dmg);
    this.hurtPlayer(dmg.total, enemy.name);

    // Devour, and the Wight's drain: it takes half of what it deals back (§5.5).
    const steal = this.lifestealFor(enemy);
    if (steal > 0 && enemy.hp > 0) {
      const healed = Math.max(1, Math.floor(dmg.total * steal));
      const before = enemy.hp;
      enemy.hp = Math.min(enemy.hpMax, enemy.hp + healed);
      if (enemy.hp > before) {
        this.log('danger', `${enemy.label} takes half of that back. (${enemy.hp}/${enemy.hpMax} HP)`);
      }
    }
  }

  /**
   * A boss phase may replace the attack it makes — the Withered Warden stops
   * hitting and starts Devouring at half health (§5.5). Everything else uses
   * the enemy's own numbers.
   */
  statsFor(enemy) {
    const phase = enemy.boss && enemy.phase ? enemy.def.phases[enemy.phase - 1] : null;
    return {
      attackBonus: phase?.attackBonus ?? enemy.attackBonus,
      damage: phase?.damage ?? enemy.damage,
      attackName: phase?.attackName ?? null,
    };
  }

  /** Lifesteal can be intrinsic, or arrive with a boss phase. */
  lifestealFor(enemy) {
    if (enemy.boss && enemy.phase) {
      const phase = enemy.def.phases[enemy.phase - 1];
      if (phase?.lifesteal) return phase.lifesteal;
    }
    return enemy.lifesteal ?? 0;
  }

  // ----------------------------------------------------------- the Thrall

  /**
   * Raise the last thing destroyed this fight (§2.10).
   *
   * The Thrall is a weakened copy of what it was in life: half the HP, the same
   * reach, one less to hit. It joins the initiative order immediately after the
   * player so it acts on the turn it is raised — paying an action for something
   * that does nothing until next round would make the ability feel dead.
   */
  raiseThrall() {
    const corpse = this.lastCorpse;
    this.thrall = {
      uid: `t${++enemyUid}`,
      id: corpse.id,
      label: corpse.carried ? corpse.name : `${corpse.name} (thrall)`,
      // Full HP, not half. The Thrall exists to soak a round or two of the
      // room's attention; a half-HP Bloatrat is three hit points and dies to
      // the first swing, which made the whole ability feel like a waste of an
      // action. Measured: the weapon does not clear the dungeon at all below this.
      hp: corpse.hpMax,
      hpMax: corpse.hpMax,
      ac: corpse.ac,
      // It fights with your will behind it: the corpse's own accuracy, and your
      // CHA on its damage. Without this the Grave-Bell is the only weapon whose
      // level-1 ability adds no damage at all, and it does not clear the dungeon.
      attackBonus: corpse.attackBonus,
      damage: corpse.damage,
      damageBonus: abilityMod(this.character.abilities.cha),
    };

    const playerIndex = this.order.findIndex((a) => a.kind === 'player');
    this.order.splice(playerIndex + 1, 0, {
      kind: 'thrall',
      uid: this.thrall.uid,
      init: this.order[playerIndex].init,
      tiebreak: -1,
    });

    this.lastCorpse = null;
    this.log('good', `${this.thrall.label} gets up. It has no opinion about being asked.`);
    this.log('narration', 'Everything in the room turns to face it instead of you.');
  }

  thrallTurn() {
    const t = this.thrall;
    const target = this.living()[0];
    if (!target) return;

    const atk = rollAttack(t.attackBonus, target.ac, { purpose: `attack:thrall:${target.id}` });
    this.log('roll', `${t.label} attacks ${target.label} — ${formatRoll(atk)}`, atk);

    if (atk.outcome === 'miss' || atk.outcome === 'fumble') {
      this.log('narration', `${t.label} misses. It does not seem discouraged.`);
      return;
    }
    const dmg = rollDamage(t.damage, t.damageBonus ?? 0, {
      crit: atk.outcome === 'crit',
      purpose: 'damage:thrall',
    });
    this.log('roll', `Damage — ${formatRoll(dmg)}`, dmg);
    this.damageEnemy(target, dmg.total, { fromPlayer: true });
  }

  /** Damage aimed at the player lands on the Thrall while it stands. */
  hurtThrall(amount, sourceLabel) {
    const t = this.thrall;
    t.hp = Math.max(0, t.hp - amount);
    this.log('narration', `${t.label} takes ${amount}. ${t.hp}/${t.hpMax} left of it.`);
    if (t.hp > 0) return;

    this.log('danger', `${t.label} comes apart.`);

    // Grave-Bell level 3 — Second Death (§2.10).
    const secondDeath = knownAbilities(this.character).find((a) => a.id === 'second_death');
    if (secondDeath) {
      this.log('good', 'Second Death — nothing you raise dies quietly.');
      const burst = rollDamage(secondDeath.damage, 0, { purpose: 'damage:second_death' });
      this.log('roll', `Burst — ${formatRoll(burst)}`, burst);
      for (const e of this.living()) {
        this.damageEnemy(e, burst.total, { fromPlayer: true });
        if (this.over) return;
      }
    }
    void sourceLabel;
  }

  /** Bone Choristers strengthen each other (§5.3). */
  choirBonus(enemy) {
    if (enemy.def.trait?.kind !== 'choir') return 0;
    return this.living().filter((e) => e.id === enemy.id && e.uid !== enemy.uid).length;
  }

  /** Warren Stalkers punish whoever moved last (§5.3). */
  enemyHasAdvantage(enemy) {
    if (enemy.def.trait?.kind !== 'opportunist') return false;
    return this.lastActorUid === 'player';
  }

  /** Blade level 1 — Riposte (§2.1), once per encounter, automatic. */
  tryRiposte(enemy) {
    if (this.over) return;
    if (!hasAbility(this.character, 'riposte')) return;
    if (this.player.riposteUsed) return;
    if (enemy.hp <= 0) return;

    this.player.riposteUsed = true;
    this.log('good', 'Riposte — the miss opens them up.');
    this.resolvePlayerAttack(enemy, weaponOf(this.character), { free: true });
  }

  playerAc() {
    let ac = armourClass(this.character);
    if (this.player.defendingUntilTurn !== null) ac += 2;
    if (this.player.emberwallUntilTurn !== null) ac += 2;
    return ac;
  }

  playerSave(ability, dc, purpose) {
    // A background may grant standing advantage on one kind of save.
    const standing = hasTrait(this.character, `saveAdvantage:${ability}`);
    const advantage =
      this.player.saveAdvantage || standing ? 'advantage' : takePendingAdvantage(this.character);
    if (this.player.saveAdvantage) {
      this.log('good', 'The warding light spends itself on this.');
      this.player.saveAdvantage = false;
    } else if (standing) {
      this.log('good', `${trait(this.character, `saveAdvantage:${ability}`).name} — you have done this before.`);
    }
    const r = roll('1d20', {
      modifier: saveMod(this.character, ability) + saveItemBonus(this.character),
      kind: 'save',
      vs: dc,
      advantage,
      purpose,
      characterId: this.character.id,
    });
    this.log('roll', `${ability.toUpperCase()} save — ${formatRoll(r)}`, r);
    return r;
  }

  hurtPlayer(amount, killedBy) {
    let incoming = amount;

    // Caravan Guard's Escort: you have been standing in front of things for years.
    const escort = trait(this.character, 'halveOneHit');
    if (escort && !this.player.escortUsed && incoming > 0) {
      this.player.escortUsed = true;
      incoming = Math.floor(incoming / 2);
      this.log('good', `${escort.name} — you take the worst of it on your shoulder. Halved to ${incoming}.`);
    }

    const { dealt, dead } = applyDamage(this.character, incoming);
    this.log(
      'damage',
      `You take ${dealt}. (${this.character.hp}/${effectiveMaxHp(this.character)} HP)`
    );
    if (dead) {
      this.over = true;
      this.result = 'death';
      this.deathCause = killedBy;
    }
  }

  // ------------------------------------------------------------- rendering

  snapshot() {
    return {
      active: !this.over,
      round: this.round,
      result: this.result,
      yourTurn: this.isPlayerTurn(),
      actionUsed: this.player.actionUsed,
      bonusUsed: this.player.bonusUsed,
      onPlinth: this.player.onPlinth,
      hidden: this.player.hidden,
      markedUid: this.player.markedUid,
      ac: this.playerAc(),
      enemies: this.enemies.map((e) => ({
        uid: e.uid,
        label: e.label,
        hp: e.hp,
        hpMax: e.hpMax,
        ac: e.ac,
        alive: e.hp > 0,
        marked: this.player.markedUid === e.uid,
        burning: Boolean(e.burning),
        phase: e.phase,
        phaseName: e.boss && e.hp > 0 ? e.def.phases[e.phase - 1].name : null,
      })),
      thrall: this.thrall
        ? { label: this.thrall.label, hp: this.thrall.hp, hpMax: this.thrall.hpMax, ac: this.thrall.ac }
        : null,
      order: this.order.map((a) => ({
        name: this.actorName(a),
        init: a.init,
        current: this.order[this.turnIndex] === a,
      })),
    };
  }

  /** Enemy HP to carry over when the player flees and comes back (§4.4). */
  savedHp() {
    return this.enemies.map((e) => e.hp);
  }
}

/** Spell attack bonus — proficiency plus the casting ability, same shape as §1.3. */
function castingAttackBonus(character, ability) {
  return proficiencyBonus(character.level) + abilityMod(character.abilities[ability]);
}

function describeEnemies(enemies) {
  const living = enemies.filter((e) => e.hp > 0);
  if (living.length === 1) return `${living[0].label} — ${living[0].def.description}`;
  const counts = new Map();
  for (const e of living) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const parts = [...counts].map(([name, n]) => (n > 1 ? `${n}× ${name}` : name));
  return `${parts.join(', ')}. ${living[0].def.description}`;
}

function fail(message) {
  return { ok: false, message };
}
