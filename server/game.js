// Game session and command dispatch. GAME_DESIGN.md §5, §6, §10.
//
// Phase 1 keeps all of this in memory. The objects are shaped like the §9 tables
// so Phase 2 can swap in Postgres without reshaping the game logic.

import { randomUUID } from 'node:crypto';
import { roll, rollDamage, rollDie, formatRoll } from './dice.js';
import { getRoom, getItem, getWeapon, getBackground, startingRoomFor, weaponTutorialFor, combatProfileFor } from './content.js';
import { parse, matchName, helpText, DIRECTIONS } from './parser.js';
import { Encounter } from './combat.js';
import {
  createCharacter,
  rollStats,
  addItem,
  removeItem,
  findInventory,
  equippedItem,
  equippedEntry,
  weaponOf,
  armourClass,
  knownAbilities,
  hasAbility,
  heal as applyHeal,
  damage as applyDamage,
  restoreOnRest,
  kill,
  weaponAttackBonus,
  weaponDamageMod,
  hasTrait,
  trait,
  traitAmount,
  resourcePool,
  takePendingAdvantage,
} from './character.js';
import {
  ABILITIES,
  ABILITY_NAMES,
  abilityMod,
  skillMod,
  effectiveMaxHp,
  xpToNextLevel,
  proficiencyBonus,
  formatMod,
} from './rules.js';

export class GameSession {
  constructor() {
    this.id = randomUUID();
    this.reset();
  }

  /**
   * Rebuild a saved run after a server restart. Combat only holds data plus a
   * logging callback, so JSON is sufficient once its prototype and live
   * character reference are restored.
   */
  static restore(saved) {
    if (!saved || typeof saved !== 'object') throw new Error('Saved run is invalid.');
    const session = new GameSession();
    session.id = saved.id ?? session.id;
    session.state = saved.state ?? 'creation';
    session.character = saved.character ?? null;
    session.statPool = saved.statPool ?? rollStats();
    session.roomId = saved.roomId ?? null;
    session.rooms = saved.rooms ?? {};
    session.entries = saved.entries ?? [];
    session.recent = [];
    session.deathRecord = saved.deathRecord ?? null;
    session.encounter = saved.encounter ?? null;
    if (session.encounter) {
      Object.setPrototypeOf(session.encounter, Encounter.prototype);
      session.encounter.character = session.character;
      session.encounter.log = session.logger;
    }
    return session;
  }

  /** JSON-safe authoritative state for the account save row. */
  saveState() {
    return JSON.parse(JSON.stringify({
      id: this.id,
      state: this.state,
      character: this.character,
      statPool: this.statPool,
      roomId: this.roomId,
      rooms: this.rooms,
      encounter: this.encounter,
      entries: this.entries.slice(-500),
      deathRecord: this.deathRecord,
    }));
  }

  reset() {
    this.state = 'creation'; // creation | playing | dead | victory
    this.character = null;
    this.statPool = rollStats();
    this.roomId = null;
    this.rooms = {};
    this.encounter = null;
    this.entries = [];
    this.recent = [];
    this.deathRecord = null;
    this.push('system', 'The Undercroft is open. Six scores are on the table — they are the only six you will get.');
  }

  // ------------------------------------------------------------------- log

  push(kind, text, rollResult = null) {
    const entry = { id: this.entries.length + 1, kind, text, roll: rollResult };
    this.entries.push(entry);
    this.recent.push(entry);
    return entry;
  }

  takeRecent() {
    const out = this.recent;
    this.recent = [];
    return out;
  }

  logger = (kind, text, rollResult = null) => this.push(kind, text, rollResult);

  // -------------------------------------------------------------- creation

  publicStatPool() {
    return this.statPool.map((r, i) => ({
      index: i,
      total: r.total,
      dice: r.dice,
      kept: r.kept,
      dropped: r.dropped,
      text: formatRoll(r),
    }));
  }

  beginGame({ name, weaponId, backgroundId, assignment }) {
    if (this.state !== 'creation') {
      throw new Error('This character has already been made.');
    }
    this.character = createCharacter({
      name,
      weaponId,
      backgroundId,
      assignment,
      statPool: this.statPool,
    });
    this.state = 'playing';

    const weaponDef = getWeapon(weaponId);
    const bgDef = getBackground(backgroundId);

    this.push('level', `${this.character.name} — ${this.character.title}.`);
    this.push('system', `${bgDef.name} · ${weaponDef.name}`);
    this.push('narration', bgDef.blurb);
    this.push('narration', weaponDef.blurb);
    const tutorial = weaponTutorialFor(weaponId);
    const profile = combatProfileFor(weaponId, backgroundId);
    this.push('tutorial', `${tutorial.name.toUpperCase()} — ${tutorial.text}`);
    this.push('system', `${profile.label} · ${profile.description}`);
    this.push(
      'system',
      `HP ${this.character.hp}/${this.character.hpMax} · AC ${armourClass(this.character)} · ${this.character.marks} marks`
    );
    this.push('system', 'Type HELP at any time. Nothing below is a safe zone.');

    // The background owns the prologue — it is the "who you were" half (§5.1).
    this.enterRoom(startingRoomFor(backgroundId));
    return this.character;
  }

  // ------------------------------------------------------------------ rooms

  roomState(id = this.roomId) {
    if (!this.rooms[id]) {
      this.rooms[id] = { visited: false, searched: false, cleared: false, savedHp: null, shrineUsed: false };
    }
    return this.rooms[id];
  }

  get room() {
    return this.roomId ? getRoom(this.roomId) : null;
  }

  /**
   * Exits available right now. The Drowned Throne has none until Maugrim is
   * down, at which point the portal to Ashvault opens (§5.4).
   */
  currentExits(id = this.roomId) {
    const room = getRoom(id);
    const exits = { ...room.exits };
    if (room.exitsOnVictory && this.roomState(id).cleared) {
      Object.assign(exits, room.exitsOnVictory);
    }
    return exits;
  }

  enterRoom(id) {
    this.roomId = id;
    const room = getRoom(id);
    const state = this.roomState(id);
    const firstVisit = !state.visited;
    state.visited = true;

    this.push('room', `${room.name} — ${room.zoneName}`);
    this.push('narration', room.description);
    this.describeExits();
    if (firstVisit && room.hint) this.push('system', room.hint);

    if (room.terminal) {
      this.encounter = null;
      this.handleReachedHub();
      return;
    }

    /**
     * The Rift (§5.5). Entering is the whole event — there is no prompt and no
     * saving throw, which is the point: it reads as a hazard, not a fork. Solo
     * it pulls the only person present, so it degrades to a committed one-way
     * side route; in Phase 4 the same room pulls a subset of the party and
     * genuinely splits it.
     */
    if (room.pullsTo) {
      this.encounter = null;
      this.push('danger', room.pullText);
      this.enterRoom(room.pullsTo);
      return;
    }

    if (room.enemies.length && !state.cleared) {
      this.encounter = new Encounter({
        room,
        character: this.character,
        log: this.logger,
        savedHp: state.savedHp,
      });
      this.encounter.start();
      this.afterEncounterStep();
    } else {
      this.encounter = null;
    }
  }

  describeExits() {
    const exits = Object.keys(this.currentExits());
    if (!exits.length) {
      this.push('system', 'There is no way out of this room.');
      return;
    }
    this.push('system', `Exits: ${exits.map((e) => e.toUpperCase()).join(', ')}`);
  }

  /** Called after anything that may have ended the encounter. */
  afterEncounterStep() {
    const enc = this.encounter;
    if (!enc || !enc.over) return;

    if (enc.result === 'death') {
      this.handleDeath(enc.deathCause ?? 'the dark');
      return;
    }
    if (enc.result === 'victory') {
      this.roomState().cleared = true;
      this.roomState().savedHp = null;
      if (this.room.boss) this.handleBossVictory();
      else this.describeExits();
      this.encounter = null;
      return;
    }
    if (enc.result === 'fled') {
      this.roomState().savedHp = enc.savedHp();
      this.encounter = null;
      const back = this.retreatTarget();
      if (back) this.enterRoom(back);
      return;
    }
  }

  retreatTarget() {
    const exits = this.currentExits();
    // Fall back the way you came: the first exit that leads somewhere already visited.
    for (const dest of Object.values(exits)) {
      if (this.rooms[dest]?.visited) return dest;
    }
    return Object.values(exits)[0] ?? null;
  }

  handleBossVictory() {
    const bossDef = this.encounter.enemies.find((e) => e.boss).def;
    // Boss-specific text lives in content, so a second boss needs no code here.
    this.push('level', bossDef.victoryTitle);
    this.push('narration', bossDef.victoryText);

    const seal = getItem(bossDef.guaranteedDrop);
    addItem(this.character, seal.id, 1);
    this.push('good', `${seal.name} — ${seal.description}`);

    const table = bossDef.lootTable;
    const pick = rollDie(table.length);
    const lootRoll = { notation: `1d${table.length}`, dice: [pick], kept: [pick], dropped: [], modifier: 0, total: pick, vs: null, vsLabel: 'DC', outcome: null, advantage: 'none', verified: true };
    this.push('roll', `Loot — ${formatRoll(lootRoll)}`, lootRoll);
    const loot = getItem(table[pick - 1]);
    addItem(this.character, loot.id, 1);
    this.push('good', `${loot.name} (${loot.rarity}) — ${loot.description}`);

    // Only the gate boss grants hub access; the Crypt is optional content past it.
    if (bossDef.unlocksHub) {
      this.character.hubUnlocked = true;
      this.push('level', `${this.character.name} is hub-unlocked. Ashvault will open to this character, and to this character only.`);
    }
    this.push('system', bossDef.victoryHint);
    this.describeExits();
  }

  /** Stepping through the portal is where Phase 1 ends and Phase 3 will begin. */
  handleReachedHub() {
    this.state = 'victory';
    this.push('level', `${this.character.name} has reached Ashvault.`);
    this.push(
      'system',
      'Phase 1 ends here. The city itself — chat, parties, the bank, the shops — is Phase 3. SHEET shows the flag you earned to get in.'
    );
  }

  handleDeath(killedBy) {
    const lost = kill(this.character, { killedBy, room: this.roomId });
    this.state = 'dead';
    this.encounter = null;
    this.deathRecord = {
      name: this.character.name,
      weaponId: this.character.weaponId,
      level: this.character.level,
      killedBy,
      room: getRoom(this.roomId).name,
      lost: lost.map((l) => ({ name: getItem(l.itemId).name, qty: l.qty })),
      diedAt: this.character.diedAt,
    };

    this.push('death', `${this.character.name} is dead.`);
    this.push('death', `Killed by ${killedBy}, at level ${this.character.level}, in ${this.deathRecord.room}.`);
    if (lost.length) {
      this.push(
        'death',
        `Lost: ${this.deathRecord.lost.map((l) => (l.qty > 1 ? `${l.name} ×${l.qty}` : l.name)).join(', ')}.`
      );
    }
    this.push('death', 'There is no resuming this character. There was never going to be.');
    this.push('system', 'RESTART to roll a new one.');
  }

  // ---------------------------------------------------------------- command

  command(input) {
    this.recent = [];
    const parsed = parse(input);

    if (!parsed.ok) {
      this.push('error', parsed.message);
      return this.response();
    }

    this.push('command', `> ${parsed.raw}`);

    try {
      this.dispatch(parsed);
    } catch (err) {
      this.push('error', err.message);
    }
    return this.response();
  }

  dispatch(cmd) {
    if (cmd.verb === 'help') return this.push('system', helpText());
    if (cmd.verb === 'restart') return this.doRestart();

    if (this.state === 'creation') {
      return this.push('error', 'Make a character first.');
    }
    if (this.state === 'dead') {
      if (cmd.verb === 'sheet') return this.doSheet();
      return this.push('error', 'You are dead. RESTART, or sit with it a while.');
    }

    switch (cmd.verb) {
      case 'look': return this.doLook(cmd.arg);
      case 'sheet': return this.doSheet();
      case 'inventory': return this.doInventory();
      case 'move': return this.doMove(cmd.arg);
      case 'search': return this.doSearch();
      case 'rest': return this.doRest();
      case 'attack': return this.doAttack(cmd.arg);
      case 'ability': return this.doAbility(cmd.arg, cmd.target);
      case 'defend': return this.inCombat(() => this.finish(this.encounter.playerDefend()));
      case 'pass': return this.inCombat(() => this.finish(this.encounter.playerPass()));
      case 'flee': return this.inCombat(() => this.finish(this.encounter.playerFlee()));
      case 'climb': return this.doClimb();
      case 'descend': return this.doDescend();
      case 'equip': return this.doEquip(cmd.arg);
      case 'unequip': return this.doUnequip(cmd.arg);
      case 'use': return this.doUse(cmd.arg);
      case 'foresee': return this.doForesee();
      case 'recant': return this.doRecant();
      default: return this.push('error', `${cmd.verb.toUpperCase()} is not something you can do here.`);
    }
  }

  fighting() {
    return Boolean(this.encounter && !this.encounter.over);
  }

  inCombat(fn) {
    if (!this.fighting()) return this.push('error', 'Nothing here is fighting you.');
    return fn();
  }

  /** Report a rejected combat action, or settle the encounter after a good one. */
  finish(result) {
    if (result && result.ok === false) return this.push('error', result.message);
    this.afterEncounterStep();
    return result;
  }

  // ------------------------------------------------------------- verbs

  doLook(arg) {
    const room = this.room;
    if (!arg) {
      this.push('room', `${room.name} — ${room.zoneName}`);
      this.push('narration', room.description);
      if (this.fighting()) {
        for (const e of this.encounter.living()) {
          this.push('danger', `${e.label} — ${e.hp}/${e.hpMax} HP, AC ${e.ac}. ${e.def.description}`);
        }
      }
      this.describeExits();
      if (room.search && !this.roomState().searched) {
        this.push('system', room.search.promptText ?? 'There is something here worth a proper SEARCH.');
      }
      return;
    }

    if (this.fighting()) {
      const enemy = matchName(arg, this.encounter.living(), (e) => e.label);
      if (enemy) {
        this.push('danger', `${enemy.label} — ${enemy.hp}/${enemy.hpMax} HP, AC ${enemy.ac}.`);
        this.push('narration', enemy.def.description);
        if (enemy.boss) {
          this.push('system', `Phase ${enemy.phase}: ${enemy.def.phases[enemy.phase - 1].name}`);
        }
        return;
      }
    }

    const entry = matchName(arg, this.character.inventory, (e) => getItem(e.itemId).name);
    if (entry) {
      const item = getItem(entry.itemId);
      this.push('narration', `${item.name} — ${item.description}`);
      return;
    }

    this.push('narration', `You look for ${arg}, and find nothing worth the name.`);
  }

  doSheet() {
    const c = this.character;
    const weaponDef = getWeapon(c.weaponId);
    const bgDef = getBackground(c.backgroundId);

    this.push('room', `${c.name} — level ${c.level} ${c.title}`);
    this.push('system', `${bgDef.name} · ${weaponDef.name}`);
    this.push(
      'system',
      `HP ${c.hp}/${effectiveMaxHp(c)}${c.hpMaxPenalty ? ` (max reduced by ${c.hpMaxPenalty})` : ''} · AC ${armourClass(c)} · Proficiency ${formatMod(proficiencyBonus(c.level))}`
    );
    this.push(
      'system',
      ABILITIES.map((a) => `${a.toUpperCase()} ${c.abilities[a]} (${formatMod(abilityMod(c.abilities[a]))})`).join('  ')
    );
    if (c.resource) {
      this.push('system', `${c.resource.name}: ${c.resource.current}/${c.resource.max}`);
    }
    const next = xpToNextLevel(c.xp);
    this.push('system', `XP ${c.xp}${next === null ? ' (max level)' : ` · ${next} to next level`} · ${c.marks} marks`);

    const weapon = weaponOf(c);
    this.push(
      'system',
      `Attack ${formatMod(weaponAttackBonus(c))} with ${weapon.name} for ${weapon.damage}${formatMod(weaponDamageMod(c))}`
    );
    this.push('system', `Skill: ${bgDef.skillProficiency} ${formatMod(skillMod(c, bgDef.skillProficiency))} · Saves: ${c.saveProficiencies.map((s) => s.toUpperCase()).join(', ')}`);

    for (const ability of knownAbilities(c)) {
      const spent = ability.uses === 'rest' && c.restUses[ability.id] ? ' (spent until rest)' : '';
      this.push('narration', `${ability.name} [L${ability.level}, ${ability.type}${ability.cost ? `, ${ability.cost} ${weaponDef.resource.name}` : ''}]${spent} — ${ability.text}`);
    }

    this.push('system', `Status: ${c.status}${c.hubUnlocked ? ' · HUB-UNLOCKED' : ''}${c.usedManualDice ? ' · manual dice used (unranked)' : ''}`);
  }

  doInventory() {
    const c = this.character;
    if (!c.inventory.length) {
      this.push('narration', 'You carry nothing at all.');
      return;
    }
    const equippedUids = new Set(Object.values(c.equipment).filter(Boolean));
    for (const entry of c.inventory) {
      const item = getItem(entry.itemId);
      const tags = [];
      if (equippedUids.has(entry.uid)) tags.push('equipped');
      if (entry.qty > 1) tags.push(`×${entry.qty}`);
      if (item.rarity && item.rarity !== 'common') tags.push(item.rarity);
      this.push('narration', `${item.name}${tags.length ? ` (${tags.join(', ')})` : ''} — ${item.description}`);
    }
    this.push('system', `${c.marks} marks.`);
  }

  doMove(direction) {
    if (this.fighting()) {
      return this.push('error', 'You cannot simply walk away from this. FLEE, or finish it.');
    }
    const dir = DIRECTIONS[direction] ?? direction;
    const dest = this.currentExits()[dir];
    if (!dest) {
      const available = Object.keys(this.currentExits()).map((e) => e.toUpperCase()).join(', ');
      return this.push('error', available ? `Nothing that way. Exits: ${available}` : 'There is no way out of this room.');
    }
    this.enterRoom(dest);
  }

  doSearch() {
    if (this.fighting()) return this.push('error', 'Not while something is trying to kill you.');

    const room = this.room;
    const state = this.roomState();
    if (!room.search) {
      this.push('narration', 'You turn the room over and come up with nothing but wet stone.');
      return;
    }
    if (state.searched) {
      this.push('narration', 'You have already had everything this room is going to give up.');
      return;
    }
    state.searched = true;

    if (room.search.challenge) return this.doSearchChallenge(room.search);

    this.push('good', room.search.text);
    for (const itemId of room.search.items ?? []) {
      addItem(this.character, itemId, 1);
      const item = getItem(itemId);
      this.push('good', `${item.name} — ${item.description}`);
    }
    if (room.search.marks) {
      const r = rollDamage(room.search.marks, 0, { purpose: 'loot:marks' });
      this.push('roll', `Purse — ${formatRoll(r)}`, r);
      this.character.marks += this.scaleMarks(r.total);
      this.push('good', `+${this.scaleMarks(r.total)} marks. (${this.character.marks} total)`);
    }

    // Gutter Rat's Light Fingers: nothing comes up empty.
    const fingers = trait(this.character, 'searchBonus');
    if (fingers) {
      const extra = rollDamage('2d6+4', 0, { purpose: 'loot:light_fingers' });
      const gained = this.scaleMarks(extra.total);
      this.character.marks += gained;
      this.push('good', `${fingers.name} — you also come away with ${gained} marks nobody was counting.`);
    }
  }

  /** Debt Collector's Ledger: you have never once been short-changed. */
  scaleMarks(amount) {
    const ledger = trait(this.character, 'marksMultiplier');
    return Math.floor(amount * (ledger?.amount ?? 1));
  }

  /** §5.2 room 3 — the one skill challenge in the dungeon. */
  doSearchChallenge(challenge) {
    const c = this.character;

    if (hasAbility(c, 'trapsense')) {
      this.push('good', 'Trapsense — you see which caps are wrong before your hand gets near them. No roll needed.');
      return this.applyChallengeOutcome(challenge.onSuccess);
    }

    const sight = trait(c, `skillAdvantage:${challenge.skill}`);
    if (sight) this.push('good', `${sight.name} — you have always seen a little more than was there.`);

    const r = roll('1d20', {
      modifier: skillMod(c, challenge.skill),
      kind: 'check',
      vs: challenge.dc,
      advantage: sight ? 'advantage' : takePendingAdvantage(c),
      purpose: `check:${challenge.skill}`,
      characterId: c.id,
    });
    this.push('roll', `${challenge.skill.toUpperCase()} check — ${formatRoll(r)}`, r);

    if (r.outcome === 'success') return this.applyChallengeOutcome(challenge.onSuccess);

    this.push('danger', challenge.onFailure.text);

    // Fenwitch's Hedge-Craft: you knew which caps were wrong before you could read.
    if (challenge.onFailure.damageType === 'poison' && hasTrait(c, 'immunePoison')) {
      this.push('good', 'Hedge-Craft — it does absolutely nothing to you. You have breathed worse on purpose.');
      return;
    }

    const dmg = rollDamage(challenge.onFailure.damage, 0, { purpose: 'damage:sporecap' });
    this.push('roll', `Poison — ${formatRoll(dmg)}`, dmg);
    const { dead } = applyDamage(c, dmg.total);
    this.push('damage', `You take ${dmg.total}. (${c.hp}/${effectiveMaxHp(c)} HP)`);
    if (dead) this.handleDeath('sporecap poison');
  }

  applyChallengeOutcome(outcome) {
    this.push('good', outcome.text);
    for (const itemId of outcome.items ?? []) {
      addItem(this.character, itemId, 1);
      const item = getItem(itemId);
      this.push('good', `${item.name} (${item.rarity}) — ${item.description}`);
    }
  }

  /** §4.5 — one rest per dungeon run, and the shrine goes cold after it. */
  doRest() {
    if (this.fighting()) return this.push('error', 'Not here. Not now.');
    if (!this.room.shrine) return this.push('error', 'There is no shrine here to rest at.');
    if (this.roomState().shrineUsed) {
      return this.push(
        'error',
        this.room.camp
          ? 'The camp does not do that twice. You have had your night.'
          : 'The stone is cold. It gave you what it had.'
      );
    }
    const camp = Boolean(this.room.camp);
    this.roomState().shrineUsed = true;
    restoreOnRest(this.character);
    this.push(
      'good',
      camp
        ? 'You eat something hot, and sleep badly, and wake up as ready as you are going to get.'
        : 'The lantern-mark warms under your hand, and then does not.'
    );
    this.push(
      'good',
      `Restored: ${this.character.hp}/${effectiveMaxHp(this.character)} HP${this.character.resource ? `, ${this.character.resource.current}/${this.character.resource.max} ${this.character.resource.name}` : ''}.`
    );
    this.push(
      'system',
      camp
        ? 'The camp does not do that twice. Everything past the north mouth costs something.'
        : 'That was the only rest in the dungeon.'
    );
  }

  doAttack(arg) {
    if (!this.fighting()) return this.push('error', 'Nothing here is fighting you.');
    if (!this.encounter.isPlayerTurn()) return this.push('error', 'It is not your turn.');

    const living = this.encounter.living();
    let target;
    if (arg) {
      target = matchName(arg, living, (e) => e.label);
      if (!target) {
        return this.push('error', `No "${arg}" here. Targets: ${living.map((e) => e.label).join(', ')}`);
      }
    } else {
      target = [...living].sort((a, b) => a.hp - b.hp)[0];
    }
    this.finish(this.encounter.playerAttack(target));
  }

  doAbility(name, targetName) {
    const c = this.character;
    const ability = matchName(name, knownAbilities(c), (a) => a.name)
      ?? matchName(name, knownAbilities(c), (a) => a.id);
    if (!ability) {
      const known = knownAbilities(c).map((a) => a.name).join(', ') || 'none yet';
      return this.push('error', `You do not know "${name}". You know: ${known}.`);
    }
    if (!this.fighting()) {
      return this.push('error', `${ability.name} is for a fight, and there is not one.`);
    }
    if (!this.encounter.isPlayerTurn()) return this.push('error', 'It is not your turn.');

    let enemy = null;
    if (ability.targets === 'enemy') {
      const living = this.encounter.living();
      enemy = targetName ? matchName(targetName, living, (e) => e.label) : living[0];
      if (!enemy) {
        return this.push('error', `No such target. Targets: ${living.map((e) => e.label).join(', ')}`);
      }
    }

    const result = this.encounter.playerAbility(ability, enemy);
    if (result.ok === false) return this.push('error', result.message);
    if (result.endsTurn && !this.encounter.over) this.encounter.endPlayerTurn();
    this.afterEncounterStep();
  }

  doClimb() {
    if (!this.fighting()) {
      if (!this.room.plinth) return this.push('error', 'There is nothing here to climb.');
      return this.push('error', 'Nothing is chasing you up there yet.');
    }
    this.finish(this.encounter.playerClimb());
  }

  doDescend() {
    if (!this.fighting()) return this.push('error', 'You are not on the plinth.');
    this.finish(this.encounter.playerDescend());
  }

  doEquip(arg) {
    if (this.fighting()) return this.push('error', 'Not while something is trying to kill you.');
    const entry = matchName(arg, this.character.inventory, (e) => getItem(e.itemId).name);
    if (!entry) return this.push('error', `You are not carrying "${arg}".`);
    const item = getItem(entry.itemId);
    if (!item.slot) return this.push('error', `${item.name} is not something you can wear or wield.`);

    const previous = equippedEntry(this.character, item.slot);
    this.character.equipment[item.slot] = entry.uid;
    this.push('good', `${item.name} — ${item.slot}.`);
    if (previous && previous.uid !== entry.uid) {
      this.push('narration', `You stow the ${getItem(previous.itemId).name}.`);
    }
    this.push('system', `AC ${armourClass(this.character)}.`);
  }

  doUnequip(arg) {
    if (this.fighting()) return this.push('error', 'Not while something is trying to kill you.');
    for (const slot of Object.keys(this.character.equipment)) {
      const item = equippedItem(this.character, slot);
      if (item && matchName(arg, [item], (i) => i.name)) {
        this.character.equipment[slot] = null;
        this.push('good', `You stow the ${item.name}.`);
        this.push('system', `AC ${armourClass(this.character)}.`);
        return;
      }
    }
    this.push('error', `You have no "${arg}" equipped.`);
  }

  doUse(arg) {
    const c = this.character;
    const entry = matchName(arg, c.inventory, (e) => getItem(e.itemId).name);
    if (!entry) return this.push('error', `You are not carrying "${arg}".`);
    const item = getItem(entry.itemId);

    if (item.usePerDungeon) return this.useUtilityItem(entry, item);

    if (!item.consumable) {
      return this.push('error', `${item.name} is not something you can spend. Try EQUIP.`);
    }
    if (this.fighting()) {
      if (!item.combatUse) {
        return this.push('error', `No time for ${item.name} with something swinging at you.`);
      }
      if (!this.encounter.isPlayerTurn()) return this.push('error', 'It is not your turn.');
      if (this.encounter.player.actionUsed) {
        return this.push('error', 'You have already acted this turn. PASS to end it.');
      }
    }

    const r = rollDamage(item.heal, 0, { purpose: `heal:${item.id}`, characterId: c.id });
    const healed = applyHeal(c, r.total);
    removeItem(c, entry, 1);
    this.push('roll', `${item.name} — ${formatRoll(r)}`, r);
    this.push('good', `You recover ${healed} HP. (${c.hp}/${effectiveMaxHp(c)})`);

    if (this.fighting()) {
      this.encounter.consumeAction();
      this.encounter.endPlayerTurn();
      this.afterEncounterStep();
    }
  }

  useUtilityItem(entry, item) {
    const c = this.character;
    if (c.dungeonUses[item.id]) {
      return this.push('error', `${item.name} has already been used on this run.`);
    }

    if (item.usePerDungeon === 'reroll_initiative') {
      if (!this.fighting()) return this.push('error', 'There is no order to change.');
      c.dungeonUses[item.id] = true;
      this.push('good', 'One long note. Everything in the room re-sorts itself around it.');
      this.encounter.rerollInitiative();
      this.encounter.resume();
      this.afterEncounterStep();
      return;
    }

    if (item.usePerDungeon === 'identify') {
      // Nothing in Phase 1 is unidentified — every item shows its full stats on
      // pickup — so this is flavour until an identification system exists.
      this.push('narration', 'You leaf through what survived of the journal. Nothing down here is a mystery yet.');
      return;
    }

    this.push('narration', `${item.name} does nothing here.`);
  }

  /** Disgraced Scholar's Marginalia (§3). Once per run. */
  doForesee() {
    const c = this.character;
    const ability = trait(c, 'nextRollAdvantage');
    if (!ability) return this.push('error', 'You have not read ahead. That is somebody else\'s trick.');
    if (c.dungeonUses.marginalia) {
      return this.push('error', 'You have already spent what you remembered of this place.');
    }
    if (c.pendingAdvantage) return this.push('error', 'You are already reading ahead.');
    c.dungeonUses.marginalia = true;
    c.pendingAdvantage = true;
    this.push('good', `${ability.name} — somebody wrote this part down. Your next roll is made with advantage.`);
  }

  /** Apostate's Recant (§3). Once per run. */
  doRecant() {
    const c = this.character;
    const ability = trait(c, 'restoreResource');
    if (!ability) return this.push('error', 'You have nothing to take back.');
    if (!c.resource) return this.push('error', 'You carry no charges to restore.');
    if (c.dungeonUses.recant) {
      return this.push('error', 'You have said it once already. It does not work twice.');
    }
    c.dungeonUses.recant = true;
    const before = c.resource.current;
    c.resource.current = c.resource.max;
    this.push('good', `${ability.name} — you say it again, out loud, and something gives.`);
    this.push('good', `${c.resource.name} restored: ${before} → ${c.resource.current}/${c.resource.max}.`);
  }

  doRestart() {
    if (this.state === 'playing') {
      return this.push('error', 'You have a living character. Finish the run, or die trying.');
    }
    this.reset();
  }

  // ------------------------------------------------------------- rendering

  response() {
    return { entries: this.takeRecent(), state: this.snapshot() };
  }

  snapshot() {
    const base = {
      sessionId: this.id,
      state: this.state,
      character: null,
      room: null,
      encounter: null,
      death: this.deathRecord,
    };
    if (!this.character) return base;

    const c = this.character;
    const weaponDef = getWeapon(c.weaponId);
    const bgDef = getBackground(c.backgroundId);
    const equippedUids = new Set(Object.values(c.equipment).filter(Boolean));

    base.character = {
      id: c.id,
      name: c.name,
      weaponId: c.weaponId,
      backgroundId: c.backgroundId,
      title: c.title,
      figure: weaponDef.figure,
      weaponName: weaponDef.name,
      backgroundName: bgDef.name,
      combatProfile: combatProfileFor(c.weaponId, c.backgroundId),
      level: c.level,
      xp: c.xp,
      xpToNext: xpToNextLevel(c.xp),
      hp: c.hp,
      hpMax: effectiveMaxHp(c),
      hpMaxPenalty: c.hpMaxPenalty,
      ac: this.fighting() ? this.encounter.playerAc() : armourClass(c),
      abilities: c.abilities,
      mods: Object.fromEntries(ABILITIES.map((a) => [a, abilityMod(c.abilities[a])])),
      abilityNames: ABILITY_NAMES,
      resource: c.resource ? { ...c.resource } : null,
      marks: c.marks,
      status: c.status,
      hubUnlocked: c.hubUnlocked,
      weapon: weaponOf(c).name,
      attackBonus: weaponAttackBonus(c),
      known: knownAbilities(c).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        cost: a.cost ?? 0,
        spent: a.uses === 'rest' ? Boolean(c.restUses[a.id]) : false,
        text: a.text,
      })),
      inventory: c.inventory.map((e) => {
        const item = getItem(e.itemId);
        return {
          uid: e.uid,
          name: item.name,
          qty: e.qty,
          rarity: item.rarity,
          equipped: equippedUids.has(e.uid),
        };
      }),
    };

    if (this.roomId) {
      const room = this.room;
      base.room = {
        id: room.id,
        name: room.name,
        // The client picks its ambience bed from the zone, so it ships too.
        zone: room.zone,
        zoneName: room.zoneName,
        exits: Object.keys(this.currentExits()),
        camp: Boolean(room.camp),
        shrine: Boolean(room.shrine),
        shrineUsed: this.roomState().shrineUsed,
        searchable: Boolean(room.search) && !this.roomState().searched,
        boss: Boolean(room.boss),
      };
    }

    if (this.encounter) base.encounter = this.encounter.snapshot();
    return base;
  }
}
