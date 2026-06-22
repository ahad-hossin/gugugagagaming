/* ==========================================================================
   _engine.js — TYCOON authoritative rules engine (pure, server-side only).
   Knows nothing about Redis, Ably or HTTP. Two entry points:
     createGame(opts) -> state
     apply(state, intent, now) -> { ok, error?, state }
   `apply` works on a deep clone, so callers persist `result.state` only when
   `ok` is true. Randomness (dice, shuffles) uses Math.random — fine in the
   serverless runtime.
   ========================================================================== */
'use strict';

var BOARD = require('../../monopoly/js/boarddata.js');
var TILES = BOARD.TILES;
var GROUPS = BOARD.GROUPS;
var C = BOARD.CONST;

var AUCTION_SECS = 20;
var VOTE_SECS = 30;
var LOG_CAP = 60;
var CHAT_CAP = 50;

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function rnd(n) { return Math.floor(Math.random() * n); }
function die() { return 1 + rnd(6); }
function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = rnd(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function err(msg) { return { ok: false, error: msg }; }

function tile(i) { return TILES[i]; }
function isProp(t) { return t.type === 'street' || t.type === 'rail' || t.type === 'utility'; }

function player(s, id) { for (var i = 0; i < s.players.length; i++) if (s.players[i].id === id) return s.players[i]; return null; }
function active(s) { return player(s, s.turn.activeId); }
function alivePlayers(s) { return s.players.filter(function (p) { return !p.bankrupt; }); }
function connectedAlive(s) { return s.players.filter(function (p) { return !p.bankrupt && p.connected; }); }

function rec(s, i) {
  if (!s.props[i]) s.props[i] = { owner: null, houses: 0, mortgaged: false };
  return s.props[i];
}
function ownerOf(s, i) { var r = s.props[i]; return r ? r.owner : null; }

function groupMembers(group) { return GROUPS[group] ? GROUPS[group].members : []; }
function ownsAllGroup(s, ownerId, group) {
  var m = groupMembers(group);
  for (var k = 0; k < m.length; k++) if (ownerOf(s, m[k]) !== ownerId) return false;
  return m.length > 0;
}
function railsOwned(s, ownerId) {
  return groupMembers('rail').filter(function (i) { return ownerOf(s, i) === ownerId; }).length;
}
function utilsOwned(s, ownerId) {
  return groupMembers('utility').filter(function (i) { return ownerOf(s, i) === ownerId; }).length;
}

function log(s, text) {
  s.log.push({ t: s._now || 0, text: text });
  if (s.log.length > LOG_CAP) s.log = s.log.slice(-LOG_CAP);
}

function netWorth(s, p) {
  var w = p.cash;
  for (var i = 0; i < TILES.length; i++) {
    if (ownerOf(s, i) === p.id) {
      var t = tile(i), r = s.props[i];
      w += r.mortgaged ? Math.floor(t.price / 2) : t.price;
      if (t.type === 'street' && r.houses > 0) w += r.houses * t.house;
    }
  }
  return w;
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------
function createGame(opts) {
  var now = opts.now || 0;
  var s = {
    code: String(opts.code).toUpperCase(),
    version: 1,
    phase: 'lobby',
    createdAt: now,
    hostId: opts.host.id,
    paused: false,
    settings: {
      maxPlayers: 8,
      startingCash: C.STARTING_CASH,
      auctions: true,
      freeParkingPot: false,
      evenBuild: true,
      fullSetDoubleRent: true,
      rentInJail: true,
      turnSeconds: 90,
      randomizeOrder: true,
      roundCap: 0
    },
    players: [],
    props: {},
    bank: { houses: C.HOUSES_SUPPLY, hotels: C.HOTELS_SUPPLY, pot: 0 },
    turn: { activeId: null, phase: 'roll', dice: null, doubles: 0, deadline: null, awaitingBuy: null, continues: false, debt: null },
    round: 0,
    pending: null,
    vote: null,
    decks: { chance: shuffle(BOARD.CHANCE.map(function (_, i) { return i; })), chest: shuffle(BOARD.CHEST.map(function (_, i) { return i; })) },
    log: [],
    reactions: [],
    chat: [],
    winnerId: null,
    endReason: null
  };
  addPlayer(s, opts.host, now);
  s.players[0].ready = true;
  log(s, opts.host.name + ' created the room.');
  return s;
}

function addPlayer(s, who, now) {
  var p = {
    id: who.id, name: String(who.name || 'Player').slice(0, 20),
    color: who.color || '#3df5ff', emoji: who.emoji || '🎩',
    order: s.players.length, cash: s.settings.startingCash,
    position: 0, inJail: false, jailTurns: 0, getOutCards: [],
    bankrupt: false, connected: true, ready: false, lastSeen: now
  };
  s.players.push(p);
  return p;
}

// ---------------------------------------------------------------------------
// apply — dispatcher
// ---------------------------------------------------------------------------
function apply(state, intent, now) {
  var s = clone(state);
  s._now = now;
  var type = intent.type;
  var pid = intent.playerId;
  var pay = intent.payload || {};
  var r;
  try {
    r = dispatch(s, type, pid, pay, now);
  } catch (e) {
    return err('engine error: ' + (e && e.message || e));
  }
  if (r && r.ok === false) return r;
  delete s._now;
  return { ok: true, state: s };
}

function dispatch(s, type, pid, pay, now) {
  // session-level intents allowed in most phases
  switch (type) {
    case 'join':          return doJoin(s, pid, pay, now);
    case 'changeIdentity':return doIdentity(s, pid, pay);
    case 'setConnected':  return doConnected(s, pid, pay, now);
    case 'leave':         return doLeave(s, pid, now);
    case 'reaction':      return doReaction(s, pid, pay, now);
    case 'chat':          return doChat(s, pid, pay, now);
  }
  if (s.phase === 'lobby') {
    switch (type) {
      case 'updateSettings': return doSettings(s, pid, pay);
      case 'setReady':       return doReady(s, pid, pay);
      case 'startGame':      return doStart(s, pid, now);
      case 'kickPlayer':     return doLobbyKick(s, pid, pay);
    }
    return err('not allowed in lobby');
  }
  if (s.phase === 'ended') return err('game over');

  // phase === 'playing'
  switch (type) {
    case 'pause':         return doPause(s, pid, true, now);
    case 'resume':        return doPause(s, pid, false, now);
    case 'claimTimeout':  return doTimeout(s, pid, now);
    case 'kickPlayer':    return doKick(s, pid, pay, now);
    case 'voteKickStart': return doVoteStart(s, pid, pay, now);
    case 'voteKickCast':  return doVoteCast(s, pid, pay, now);
    case 'tradePropose':  return doTradePropose(s, pid, pay, now);
    case 'tradeRespond':  return doTradeRespond(s, pid, pay, now);
    case 'tradeCancel':   return doTradeCancel(s, pid);
    case 'auctionBid':    return doAuctionBid(s, pid, pay, now);
    case 'auctionPass':   return doAuctionPass(s, pid, now);
  }
  if (s.paused) return err('game paused');

  // turn-gated actions below require it to be the actor's turn
  switch (type) {
    case 'rollDice':         return doRoll(s, pid, now);
    case 'buyProperty':      return doBuy(s, pid, now);
    case 'declineBuy':       return doDecline(s, pid, now);
    case 'endTurn':          return doEndTurn(s, pid, now);
    case 'buildHouse':       return doBuild(s, pid, pay, now);
    case 'sellHouse':        return doSell(s, pid, pay, now);
    case 'mortgage':         return doMortgage(s, pid, pay, now);
    case 'unmortgage':       return doUnmortgage(s, pid, pay, now);
    case 'jailPay':          return doJailPay(s, pid, now);
    case 'jailCard':         return doJailCard(s, pid, now);
    case 'jailRoll':         return doJailRoll(s, pid, now);
    case 'declareBankruptcy':return doBankruptcy(s, pid, now);
  }
  return err('unknown intent: ' + type);
}

// ---------------------------------------------------------------------------
// lobby
// ---------------------------------------------------------------------------
function doJoin(s, pid, pay, now) {
  var existing = player(s, pid);
  if (existing) { existing.connected = true; existing.lastSeen = now; return; }     // reconnect
  if (s.phase !== 'lobby') return err('game already started');
  if (s.players.length >= s.settings.maxPlayers) return err('room full');
  var p = addPlayer(s, { id: pid, name: pay.name, color: pay.color, emoji: pay.emoji }, now);
  log(s, p.name + ' joined.');
}
function doIdentity(s, pid, pay) {
  var p = player(s, pid); if (!p) return err('no such player');
  if (s.phase !== 'lobby') return err('cannot change after start');
  if (pay.name) p.name = String(pay.name).slice(0, 20);
  if (pay.color) p.color = pay.color;
  if (pay.emoji) p.emoji = pay.emoji;
}
function doSettings(s, pid, pay) {
  if (pid !== s.hostId) return err('host only');
  var n = pay || {}, set = s.settings;
  if (n.maxPlayers != null) set.maxPlayers = Math.max(2, Math.min(16, n.maxPlayers | 0));
  if (n.startingCash != null) set.startingCash = Math.max(500, Math.min(5000, n.startingCash | 0));
  if (n.auctions != null) set.auctions = !!n.auctions;
  if (n.freeParkingPot != null) set.freeParkingPot = !!n.freeParkingPot;
  if (n.evenBuild != null) set.evenBuild = !!n.evenBuild;
  if (n.fullSetDoubleRent != null) set.fullSetDoubleRent = !!n.fullSetDoubleRent;
  if (n.rentInJail != null) set.rentInJail = !!n.rentInJail;
  if (n.turnSeconds != null) set.turnSeconds = Math.max(0, Math.min(600, n.turnSeconds | 0));
  if (n.randomizeOrder != null) set.randomizeOrder = !!n.randomizeOrder;
  if (n.roundCap != null) set.roundCap = Math.max(0, Math.min(200, n.roundCap | 0));
  // reflect startingCash for not-yet-started players
  s.players.forEach(function (p) { p.cash = set.startingCash; });
}
function doReady(s, pid, pay) {
  var p = player(s, pid); if (!p) return err('no such player');
  p.ready = pay.ready == null ? !p.ready : !!pay.ready;
  if (pid === s.hostId) p.ready = true;
}
function doLobbyKick(s, pid, pay) {
  if (pid !== s.hostId) return err('host only');
  var t = player(s, pay.target); if (!t || t.id === s.hostId) return err('cannot kick');
  s.players = s.players.filter(function (p) { return p.id !== pay.target; });
  s.players.forEach(function (p, i) { p.order = i; });
  log(s, t.name + ' was removed from the lobby.');
}
function doStart(s, pid, now) {
  if (pid !== s.hostId) return err('host only');
  if (s.players.length < 2) return err('need at least 2 players');
  if (!s.players.every(function (p) { return p.ready; })) return err('not everyone is ready');
  if (s.settings.randomizeOrder) shuffle(s.players);
  s.players.forEach(function (p, i) { p.order = i; p.cash = s.settings.startingCash; });
  s.phase = 'playing';
  s.round = 1;
  s.turn = { activeId: s.players[0].id, phase: 'roll', dice: null, doubles: 0, deadline: null, awaitingBuy: null, continues: false, debt: null };
  touchDeadline(s, now);
  log(s, 'Game started — ' + s.players[0].name + ' rolls first.');
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------
function doConnected(s, pid, pay, now) {
  var p = player(s, pid); if (!p) return;
  p.connected = pay.connected == null ? true : !!pay.connected;
  p.lastSeen = now;
  if (!p.connected && pid === s.hostId) migrateHost(s);
}
function doLeave(s, pid, now) {
  var p = player(s, pid); if (!p) return;
  if (s.phase === 'lobby') {
    s.players = s.players.filter(function (x) { return x.id !== pid; });
    s.players.forEach(function (x, i) { x.order = i; });
    if (pid === s.hostId && s.players[0]) s.hostId = s.players[0].id;
    log(s, (p.name) + ' left the lobby.');
    return;
  }
  p.connected = false; p.lastSeen = now;
  if (pid === s.hostId) migrateHost(s);
}
function migrateHost(s) {
  var cand = s.players.filter(function (p) { return p.connected && !p.bankrupt; })
                      .sort(function (a, b) { return a.order - b.order; });
  if (cand.length && cand[0].id !== s.hostId) { s.hostId = cand[0].id; log(s, cand[0].name + ' is now host.'); }
}
function doReaction(s, pid, pay, now) {
  var p = player(s, pid); if (!p) return;
  s.reactions.push({ id: pid, emoji: String(pay.emoji || '👍').slice(0, 4), at: now });
  if (s.reactions.length > 20) s.reactions = s.reactions.slice(-20);
}
function doChat(s, pid, pay, now) {
  var p = player(s, pid); if (!p) return;
  var text = String(pay.text || '').slice(0, 200).trim();
  if (!text) return err('empty');
  s.chat.push({ id: pid, name: p.name, text: text, at: now });
  if (s.chat.length > CHAT_CAP) s.chat = s.chat.slice(-CHAT_CAP);
}

// ---------------------------------------------------------------------------
// turn helpers
// ---------------------------------------------------------------------------
function touchDeadline(s, now) {
  s.turn.deadline = s.settings.turnSeconds > 0 && !s.paused ? now + s.settings.turnSeconds * 1000 : null;
}
function requireTurn(s, pid) {
  if (s.turn.activeId !== pid) return err('not your turn');
  var p = player(s, pid);
  if (!p || p.bankrupt) return err('not in play');
  return null;
}

// Pay `amount` from p to creditorId (null = bank). If unaffordable, parks the
// shortfall as a debt that blocks the turn until resolved or bankruptcy.
// `toPot`: when paying the bank and freeParkingPot is on, money goes to the pot.
function charge(s, p, amount, creditorId, toPot) {
  if (amount <= 0) return true;
  if (p.cash >= amount) {
    p.cash -= amount;
    if (creditorId) { var c = player(s, creditorId); if (c) c.cash += amount; }
    else if (toPot && s.settings.freeParkingPot) s.bank.pot += amount;
    return true;
  }
  s.turn.debt = { amount: amount, creditor: creditorId || null, toPot: !!toPot };
  return false;
}

// Try to clear an outstanding debt once the player has raised enough cash.
function tryResolveDebt(s) {
  var d = s.turn.debt; if (!d) return;
  var p = active(s);
  if (p.cash >= d.amount) {
    p.cash -= d.amount;
    if (d.creditor) { var c = player(s, d.creditor); if (c) c.cash += d.amount; }
    else if (d.toPot && s.settings.freeParkingPot) s.bank.pot += d.amount;
    s.turn.debt = null;
    finishLanding(s);
  }
}

// after a landing (and any buy decision / debt) is fully settled, set up what
// the active player may do next.
function finishLanding(s) {
  if (s.turn.debt || s.pending || s.turn.awaitingBuy != null) return;
  if (checkLastStanding(s)) return;
  s.turn.phase = s.turn.continues ? 'roll' : 'end';
  touchDeadline(s, s._now);
}

function sendToJail(s, p) {
  p.position = C.JAIL_INDEX; p.inJail = true; p.jailTurns = 0;
  s.turn.continues = false;
  log(s, p.name + ' was sent to Jail.');
}

// move the active player `steps` forward (awarding GO unless suppressed),
// then resolve the tile they land on.
function moveBy(s, p, steps, awardGo) {
  var start = p.position;
  var pos = (start + steps) % 40; if (pos < 0) pos += 40;
  if (awardGo !== false && start + steps >= 40) { p.cash += C.GO_SALARY; log(s, p.name + ' passed GO (+$' + C.GO_SALARY + ').'); }
  p.position = pos;
  resolveLanding(s, p);
}
function moveTo(s, p, idx, awardGo) {
  var steps = (idx - p.position + 40) % 40;
  moveBy(s, p, steps, awardGo);
}

function resolveLanding(s, p) {
  var t = tile(p.position);
  if (t.type === 'go') { return; }
  if (t.type === 'jail' || t.type === 'parking') {
    if (t.type === 'parking' && s.settings.freeParkingPot && s.bank.pot > 0) {
      log(s, p.name + ' collected the $' + s.bank.pot + ' pot on Free Parking.');
      p.cash += s.bank.pot; s.bank.pot = 0;
    }
    return;
  }
  if (t.type === 'gotojail') { sendToJail(s, p); return; }
  if (t.type === 'tax') { charge(s, p, t.amount, null, true); if (!s.turn.debt) log(s, p.name + ' paid $' + t.amount + ' ' + t.name + '.'); return; }
  if (t.type === 'chance' || t.type === 'chest') { drawCard(s, p, t.type === 'chance' ? 'chance' : 'chest'); return; }
  if (isProp(t)) { resolveProperty(s, p, t); return; }
}

function resolveProperty(s, p, t) {
  var r = rec(s, t.i);
  if (r.owner == null) {                       // unowned → offer purchase
    if (p.cash >= t.price) { s.turn.awaitingBuy = t.i; s.turn.phase = 'buy'; }
    else if (s.settings.auctions) startAuction(s, t.i);   // can't afford → straight to auction
    return;
  }
  if (r.owner === p.id) return;                 // own property
  var owner = player(s, r.owner);
  if (!owner || owner.bankrupt) return;
  if (r.mortgaged) { log(s, t.name + ' is mortgaged — no rent.'); return; }
  if (owner.inJail && !s.settings.rentInJail) return;
  var amt = computeRent(s, t, owner.id, diceTotal(s), null);
  if (charge(s, p, amt, owner.id)) log(s, p.name + ' paid $' + amt + ' rent to ' + owner.name + '.');
}

function diceTotal(s) { return s.turn.dice ? s.turn.dice[0] + s.turn.dice[1] : 0; }

// rentOverride: {mult:'railDouble'} or {mult:10} for Chance card landings.
function computeRent(s, t, ownerId, dice, override) {
  var r = rec(s, t.i);
  if (t.type === 'street') {
    var base;
    if (r.houses > 0) base = t.rent[r.houses];
    else { base = t.rent[0]; if (s.settings.fullSetDoubleRent && ownsAllGroup(s, ownerId, t.group)) base *= 2; }
    return base;
  }
  if (t.type === 'rail') {
    var n = railsOwned(s, ownerId);
    var rent = C.RAIL_RENT[Math.max(0, n - 1)] || 0;
    if (override && override.railDouble) rent *= 2;
    return rent;
  }
  if (t.type === 'utility') {
    if (override && override.utilTen) return 10 * dice;
    var n2 = utilsOwned(s, ownerId);
    return (C.UTIL_MULT[Math.max(0, n2 - 1)] || 4) * dice;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// cards
// ---------------------------------------------------------------------------
function drawCard(s, p, deckName) {
  var deck = s.decks[deckName];
  var cards = deckName === 'chance' ? BOARD.CHANCE : BOARD.CHEST;
  var idx = deck.shift();
  var card = cards[idx];
  log(s, p.name + ' drew: ' + card.text);
  s.turn._card = { deck: deckName, text: card.text };   // surfaced for the client
  var a = card.action, keep = false;
  switch (a.kind) {
    case 'move': moveTo(s, p, a.to, true); break;
    case 'back': moveBy(s, p, -a.n, false); break;
    case 'goToJail': sendToJail(s, p); break;
    case 'getOut': p.getOutCards.push(deckName); keep = true; break;
    case 'cash': if (a.amount >= 0) p.cash += a.amount; else charge(s, p, -a.amount, null, true); break;
    case 'collectEach':
      alivePlayers(s).forEach(function (o) { if (o.id !== p.id) { var pay = Math.min(o.cash, a.amount); o.cash -= pay; p.cash += pay; } });
      break;
    case 'payEach': {
      // pay each player in turn; if the payer runs out, charge() parks the
      // remaining debt to the player they couldn't pay (never to the bank, so
      // money is never lost). They must then raise funds or go bankrupt.
      var others = alivePlayers(s).filter(function (o) { return o.id !== p.id; });
      for (var oi = 0; oi < others.length; oi++) { if (!charge(s, p, a.amount, others[oi].id)) break; }
      break;
    }
    case 'nearestRail': {
      var ri = nearest(p.position, groupMembers('rail'));
      moveTo(s, p, ri, true);
      var rr = rec(s, ri);
      if (rr.owner != null && rr.owner !== p.id && !rr.mortgaged) {
        var ramt = computeRent(s, tile(ri), rr.owner, diceTotal(s), { railDouble: true });
        if (charge(s, p, ramt, rr.owner)) log(s, p.name + ' paid $' + ramt + ' (double) rail rent.');
      }
      break;
    }
    case 'nearestUtility': {
      var ui = nearest(p.position, groupMembers('utility'));
      moveTo(s, p, ui, true);
      var ur = rec(s, ui);
      if (ur.owner != null && ur.owner !== p.id && !ur.mortgaged) {
        var uamt = computeRent(s, tile(ui), ur.owner, diceTotal(s), { utilTen: true });
        if (charge(s, p, uamt, ur.owner)) log(s, p.name + ' paid $' + uamt + ' utility rent.');
      }
      break;
    }
    case 'repairs': {
      var cost = 0;
      for (var i = 0; i < TILES.length; i++) if (ownerOf(s, i) === p.id) {
        var rr2 = s.props[i]; if (rr2.houses === 5) cost += a.perHotel; else cost += rr2.houses * a.perHouse;
      }
      charge(s, p, cost, null, true);
      break;
    }
  }
  if (!keep) deck.push(idx);    // recycle unless held as a get-out card
}
function nearest(from, list) {
  var best = list[0], bestD = 99;
  list.forEach(function (i) { var d = (i - from + 40) % 40; if (d > 0 && d < bestD) { bestD = d; best = i; } });
  return best;
}

// ---------------------------------------------------------------------------
// rolling & turn end
// ---------------------------------------------------------------------------
function doRoll(s, pid, now) {
  var e = requireTurn(s, pid); if (e) return e;
  if (s.turn.debt) return err('settle your debt first');
  if (s.turn.phase !== 'roll') return err('cannot roll now');
  var p = active(s);
  if (p.inJail) return err('use a jail option');
  var d1 = die(), d2 = die();
  s.turn.dice = [d1, d2];
  delete s.turn._card;
  var dbl = d1 === d2;
  if (dbl) s.turn.doubles++;
  log(s, p.name + ' rolled ' + d1 + ' + ' + d2 + (dbl ? ' (doubles!)' : '') + '.');
  if (dbl && s.turn.doubles >= 3) { log(s, 'Three doubles — off to Jail!'); sendToJail(s, p); s.turn.phase = 'end'; touchDeadline(s, now); return; }
  s.turn.continues = dbl;
  moveBy(s, p, d1 + d2, true);
  finishLanding(s);
}

function doEndTurn(s, pid, now) {
  var e = requireTurn(s, pid); if (e) return e;
  if (s.turn.debt) return err('settle your debt first');
  if (s.pending) return err('resolve the pending action first');
  if (s.turn.awaitingBuy != null) return err('decide on the property first');
  if (s.turn.phase === 'roll' && !active(s).inJail) return err('you still need to roll');
  advanceTurn(s, now);
}

function advanceTurn(s, now) {
  if (checkLastStanding(s)) return;
  var ordered = s.players.slice().sort(function (a, b) { return a.order - b.order; });
  var curOrder = active(s).order;
  var next = null;
  for (var step = 1; step <= ordered.length; step++) {
    var cand = ordered[(curOrder + step) % ordered.length];
    if (!cand.bankrupt) { next = cand; break; }
  }
  if (!next) { endGame(s, null, 'no players left'); return; }
  if (next.order <= curOrder) {                 // wrapped → new round
    s.round++;
    if (s.settings.roundCap > 0 && s.round > s.settings.roundCap) { endByNetWorth(s); return; }
  }
  s.turn = { activeId: next.id, phase: 'roll', dice: null, doubles: 0, deadline: null, awaitingBuy: null, continues: false, debt: null };
  touchDeadline(s, now);
  log(s, "It's " + next.name + "'s turn.");
}

// ---------------------------------------------------------------------------
// buying / auctions
// ---------------------------------------------------------------------------
function doBuy(s, pid, now) {
  var e = requireTurn(s, pid); if (e) return e;
  if (s.turn.awaitingBuy == null) return err('nothing to buy');
  var i = s.turn.awaitingBuy, t = tile(i), p = active(s);
  if (p.cash < t.price) return err('not enough cash');
  p.cash -= t.price; rec(s, i).owner = p.id;
  log(s, p.name + ' bought ' + t.name + ' for $' + t.price + '.');
  s.turn.awaitingBuy = null;
  finishLanding(s);
}
function doDecline(s, pid, now) {
  var e = requireTurn(s, pid); if (e) return e;
  if (s.turn.awaitingBuy == null) return err('nothing to decline');
  var i = s.turn.awaitingBuy; s.turn.awaitingBuy = null;
  if (s.settings.auctions) startAuction(s, i);
  else { log(s, tile(i).name + ' was not bought.'); finishLanding(s); }
}

function startAuction(s, i) {
  var bidders = alivePlayers(s).map(function (p) { return p.id; });
  s.pending = { kind: 'auction', tile: i, bids: {}, high: null, active: bidders, passed: [], deadline: (s._now || 0) + AUCTION_SECS * 1000 };
  log(s, 'Auction started for ' + tile(i).name + '.');
}
function doAuctionBid(s, pid, pay, now) {
  if (!s.pending || s.pending.kind !== 'auction') return err('no auction');
  var au = s.pending, p = player(s, pid);
  if (!p || p.bankrupt) return err('cannot bid');
  if (au.passed.indexOf(pid) >= 0) return err('you passed');
  var amt = pay.amount | 0;
  var min = au.high ? au.high.amount + 1 : 1;
  if (amt < min) return err('bid too low');
  if (amt > p.cash) return err('cannot afford bid');
  au.high = { id: pid, amount: amt };
  au.deadline = now + AUCTION_SECS * 1000;
  log(s, p.name + ' bid $' + amt + '.');
}
function doAuctionPass(s, pid, now) {
  if (!s.pending || s.pending.kind !== 'auction') return err('no auction');
  var au = s.pending;
  if (au.active.indexOf(pid) < 0) return err('not in auction');
  au.passed.push(pid);
  au.active = au.active.filter(function (x) { return x !== pid; });
  resolveAuctionIfDone(s, now);
}
function resolveAuctionIfDone(s, now) {
  var au = s.pending; if (!au || au.kind !== 'auction') return;
  if (au.active.length > 1) return;
  // the high bidder wins; if nobody ever bid, the lot stays unsold
  if (au.high) {
    var w = player(s, au.high.id);
    w.cash -= au.high.amount; rec(s, au.tile).owner = w.id;
    log(s, w.name + ' won ' + tile(au.tile).name + ' for $' + au.high.amount + '.');
  } else {
    log(s, 'No bids — ' + tile(au.tile).name + ' stays unsold.');
  }
  s.pending = null;
  finishLanding(s);
}

// ---------------------------------------------------------------------------
// building / mortgage
// ---------------------------------------------------------------------------
function doBuild(s, pid, pay, now) {
  var e = requireTurn(s, pid); if (e) return e;
  if (s.turn.debt) return err('settle your debt first');
  var i = pay.tile | 0, t = tile(i), p = active(s), r = s.props[i];
  if (!r || r.owner !== pid || t.type !== 'street') return err('cannot build here');
  if (!ownsAllGroup(s, pid, t.group)) return err('need the full colour group');
  if (anyMortgagedInGroup(s, t.group)) return err('a property in this group is mortgaged');
  if (r.houses >= 5) return err('already a hotel');
  if (s.settings.evenBuild && !evenBuildOk(s, t.group, i, +1)) return err('build evenly across the group');
  if (r.houses === 4) { if (s.bank.hotels <= 0) return err('no hotels left'); }
  else { if (s.bank.houses <= 0) return err('no houses left'); }
  if (p.cash < t.house) return err('not enough cash');
  p.cash -= t.house;
  if (r.houses === 4) { s.bank.hotels--; s.bank.houses += 4; }   // 4 houses return to bank, hotel out
  else { s.bank.houses--; }
  r.houses++;
  log(s, p.name + (r.houses === 5 ? ' built a hotel on ' : ' built a house on ') + t.name + '.');
}
function doSell(s, pid, pay, now) {
  var e = requireTurn(s, pid); if (e) return e;
  var i = pay.tile | 0, t = tile(i), p = active(s), r = s.props[i];
  if (!r || r.owner !== pid || t.type !== 'street' || r.houses <= 0) return err('nothing to sell');
  if (s.settings.evenBuild && !evenBuildOk(s, t.group, i, -1)) return err('sell evenly across the group');
  if (r.houses === 5) {                          // hotel → need 4 houses available, else partial
    if (s.bank.houses < 4) return err('not enough houses in bank to break the hotel');
    s.bank.hotels++; s.bank.houses -= 4;
  } else { s.bank.houses++; }
  r.houses--;
  p.cash += Math.floor(t.house / 2);
  log(s, p.name + ' sold a building on ' + t.name + '.');
  tryResolveDebt(s);
}
function anyMortgagedInGroup(s, group) {
  return groupMembers(group).some(function (i) { var r = s.props[i]; return r && r.mortgaged; });
}
function evenBuildOk(s, group, tileIdx, delta) {
  var members = groupMembers(group);
  var after = members.map(function (i) { var r = s.props[i]; var h = r ? r.houses : 0; return i === tileIdx ? h + delta : h; });
  var mn = Math.min.apply(null, after), mx = Math.max.apply(null, after);
  return (mx - mn) <= 1;
}
function doMortgage(s, pid, pay, now) {
  var e = requireTurn(s, pid); if (e) return e;
  var i = pay.tile | 0, t = tile(i), p = active(s), r = s.props[i];
  if (!r || r.owner !== pid || !isProp(t)) return err('cannot mortgage');
  if (r.mortgaged) return err('already mortgaged');
  if (t.type === 'street' && anyHousesInGroup(s, t.group)) return err('sell buildings in this group first');
  r.mortgaged = true; p.cash += t.mortgage;
  log(s, p.name + ' mortgaged ' + t.name + ' for $' + t.mortgage + '.');
  tryResolveDebt(s);
}
function doUnmortgage(s, pid, pay, now) {
  var e = requireTurn(s, pid); if (e) return e;
  if (s.turn.debt) return err('settle your debt first');
  var i = pay.tile | 0, t = tile(i), p = active(s), r = s.props[i];
  if (!r || r.owner !== pid || !r.mortgaged) return err('not mortgaged');
  var cost = Math.ceil(t.mortgage * 1.1);
  if (p.cash < cost) return err('not enough cash');
  p.cash -= cost; r.mortgaged = false;
  log(s, p.name + ' lifted the mortgage on ' + t.name + ' for $' + cost + '.');
}
function anyHousesInGroup(s, group) {
  return groupMembers(group).some(function (i) { var r = s.props[i]; return r && r.houses > 0; });
}

// ---------------------------------------------------------------------------
// jail
// ---------------------------------------------------------------------------
function doJailPay(s, pid, now) {
  var e = requireTurn(s, pid); if (e) return e;
  var p = active(s); if (!p.inJail) return err('not in jail');
  if (s.turn.phase !== 'roll') return err('cannot do this now');
  if (!charge(s, p, C.JAIL_FINE, null, true)) return; // debt path
  p.inJail = false; p.jailTurns = 0;
  log(s, p.name + ' paid $' + C.JAIL_FINE + ' to leave Jail.');
}
function doJailCard(s, pid, now) {
  var e = requireTurn(s, pid); if (e) return e;
  var p = active(s); if (!p.inJail) return err('not in jail');
  if (!p.getOutCards.length) return err('no get-out card');
  var deck = p.getOutCards.pop();
  s.decks[deck].push(deck === 'chance' ? BOARD.CHANCE.findIndex(byGetOut) : BOARD.CHEST.findIndex(byGetOut));
  p.inJail = false; p.jailTurns = 0;
  log(s, p.name + ' used a Get Out of Jail Free card.');
}
function byGetOut(c) { return c.action.kind === 'getOut'; }
function doJailRoll(s, pid, now) {
  var e = requireTurn(s, pid); if (e) return e;
  var p = active(s); if (!p.inJail) return err('not in jail');
  if (s.turn.phase !== 'roll') return err('cannot do this now');
  var d1 = die(), d2 = die(); s.turn.dice = [d1, d2];
  log(s, p.name + ' tried to roll out of Jail: ' + d1 + ' + ' + d2 + '.');
  if (d1 === d2) {
    p.inJail = false; p.jailTurns = 0; s.turn.continues = false;
    moveBy(s, p, d1 + d2, true); finishLanding(s);
  } else {
    p.jailTurns++;
    if (p.jailTurns >= 3) {
      log(s, 'Third failed roll — must pay the fine.');
      if (!charge(s, p, C.JAIL_FINE, null, true)) return;
      p.inJail = false; p.jailTurns = 0;
      moveBy(s, p, d1 + d2, true); finishLanding(s);
    } else {
      s.turn.phase = 'end'; touchDeadline(s, now);
    }
  }
}

// ---------------------------------------------------------------------------
// bankruptcy
// ---------------------------------------------------------------------------
function doBankruptcy(s, pid, now) {
  var e = requireTurn(s, pid); if (e) return e;
  var p = active(s);
  if (!s.turn.debt && p.cash >= 0) return err('not in debt');
  var creditorId = s.turn.debt ? s.turn.debt.creditor : null;
  bankrupt(s, p, creditorId);
  s.turn.debt = null;
  if (!checkLastStanding(s)) advanceTurn(s, now);
}
function bankrupt(s, p, creditorId) {
  p.bankrupt = true;
  log(s, p.name + ' went bankrupt' + (creditorId ? ' to ' + (player(s, creditorId) || {}).name : '') + '. Now spectating.');
  var creditor = creditorId ? player(s, creditorId) : null;
  if (creditor) {
    creditor.cash += Math.max(0, p.cash);
    // transfer get-out cards
    p.getOutCards.forEach(function (d) { creditor.getOutCards.push(d); });
  }
  p.cash = 0; p.getOutCards = [];
  for (var i = 0; i < TILES.length; i++) {
    if (ownerOf(s, i) === p.id) {
      var r = s.props[i], t = tile(i);
      if (t.type === 'street' && r.houses > 0) {     // buildings sold back to bank
        if (r.houses === 5) s.bank.hotels++; else s.bank.houses += r.houses;
        r.houses = 0;
      }
      if (creditor) { r.owner = creditor.id; }       // to creditor (keeps mortgage)
      else { r.owner = null; r.mortgaged = false; }   // to bank
    }
  }
}

// ---------------------------------------------------------------------------
// trading
// ---------------------------------------------------------------------------
function doTradePropose(s, pid, pay, now) {
  if (s.pending) return err('another action is pending');
  var from = player(s, pid), to = player(s, pay.to);
  if (!from || from.bankrupt) return err('cannot trade');
  if (!to || to.bankrupt || to.id === pid) return err('invalid trade partner');
  var give = normTrade(pay.give), get = normTrade(pay.get);
  var bad = validateTradeSide(s, pid, give) || validateTradeSide(s, pay.to, get);
  if (bad) return err(bad);
  if (give.cash > from.cash) return err('you do not have that much cash');
  s.pending = { kind: 'trade', id: 't' + now, from: pid, to: pay.to, give: give, get: get, status: 'open' };
  log(s, from.name + ' proposed a trade to ' + to.name + '.');
}
function normTrade(o) {
  o = o || {};
  return { cash: Math.max(0, o.cash | 0), props: (o.props || []).map(function (x) { return x | 0; }), cards: Math.max(0, o.cards | 0) };
}
function validateTradeSide(s, ownerId, side) {
  var p = player(s, ownerId);
  for (var k = 0; k < side.props.length; k++) {
    var i = side.props[k], t = tile(i);
    if (ownerOf(s, i) !== ownerId) return 'a traded property is not owned by its side';
    if (t.type === 'street' && anyHousesInGroup(s, t.group)) return 'sell buildings in a traded colour group first';
  }
  if (side.cards > p.getOutCards.length) return 'not enough get-out cards';
  return null;
}
function doTradeRespond(s, pid, pay, now) {
  if (!s.pending || s.pending.kind !== 'trade') return err('no trade pending');
  var tr = s.pending;
  if (pid !== tr.to) return err('not your trade to answer');
  if (pay.accept) {
    var bad = validateTradeSide(s, tr.from, tr.give) || validateTradeSide(s, tr.to, tr.get);
    var from = player(s, tr.from), to = player(s, tr.to);
    if (bad) { s.pending = null; return err(bad); }
    if (from.cash < tr.give.cash || to.cash < tr.get.cash) { s.pending = null; return err('insufficient cash to settle'); }
    // execute
    from.cash -= tr.give.cash; to.cash += tr.give.cash;
    to.cash -= tr.get.cash; from.cash += tr.get.cash;
    tr.give.props.forEach(function (i) { rec(s, i).owner = tr.to; });
    tr.get.props.forEach(function (i) { rec(s, i).owner = tr.from; });
    moveCards(from, to, tr.give.cards); moveCards(to, from, tr.get.cards);
    log(s, from.name + ' and ' + to.name + ' completed a trade.');
  } else {
    log(s, (player(s, tr.to) || {}).name + ' declined the trade.');
  }
  s.pending = null;
}
function moveCards(from, to, n) { for (var k = 0; k < n; k++) { if (from.getOutCards.length) to.getOutCards.push(from.getOutCards.pop()); } }
function doTradeCancel(s, pid) {
  if (!s.pending || s.pending.kind !== 'trade') return err('no trade');
  if (pid !== s.pending.from && pid !== s.pending.to && pid !== s.hostId) return err('cannot cancel');
  s.pending = null; log(s, 'Trade cancelled.');
}

// ---------------------------------------------------------------------------
// kicking & votes
// ---------------------------------------------------------------------------
function doKick(s, pid, pay, now) {
  if (pid !== s.hostId) return err('host only');
  removeFromGame(s, pay.target, now, 'kicked by host');
}
function doVoteStart(s, pid, pay, now) {
  if (s.vote) return err('a vote is already running');
  var starter = player(s, pid), target = player(s, pay.target);
  if (!starter || starter.bankrupt) return err('cannot start vote');
  if (!target || target.bankrupt || target.id === pid) return err('invalid target');
  s.vote = { target: pay.target, votes: {}, deadline: now + VOTE_SECS * 1000 };
  s.vote.votes[pid] = true;
  log(s, starter.name + ' started a vote to kick ' + target.name + '.');
  tallyVote(s, now);
}
function doVoteCast(s, pid, pay, now) {
  if (!s.vote) return err('no vote running');
  var p = player(s, pid); if (!p || p.bankrupt) return err('cannot vote');
  if (pid === s.vote.target) return err('cannot vote on yourself');
  s.vote.votes[pid] = !!pay.agree;
  tallyVote(s, now);
}
function tallyVote(s, now) {
  var v = s.vote; if (!v) return;
  var electorate = alivePlayers(s).filter(function (p) { return p.id !== v.target; });
  var yes = 0, no = 0;
  electorate.forEach(function (p) { if (v.votes[p.id] === true) yes++; else if (v.votes[p.id] === false) no++; });
  var need = Math.floor(electorate.length / 2) + 1;
  if (yes >= need) { var t = v.target; s.vote = null; removeFromGame(s, t, now, 'vote-kicked'); }
  else if (no >= need || (yes + no) >= electorate.length) { log(s, 'Vote to kick failed.'); s.vote = null; }
}
function removeFromGame(s, targetId, now, reason) {
  var t = player(s, targetId);
  if (!t || t.bankrupt) return err('no such active player');
  log(s, t.name + ' was removed (' + reason + ') and is now spectating.');
  // release assets to the bank
  for (var i = 0; i < TILES.length; i++) if (ownerOf(s, i) === targetId) {
    var r = s.props[i], tt = tile(i);
    if (tt.type === 'street' && r.houses > 0) { if (r.houses === 5) s.bank.hotels++; else s.bank.houses += r.houses; r.houses = 0; }
    r.owner = null; r.mortgaged = false;
  }
  t.bankrupt = true; t.cash = 0; t.getOutCards = [];
  if (s.turn.activeId === targetId && !checkLastStanding(s)) { s.turn.debt = null; s.turn.awaitingBuy = null; advanceTurn(s, now); }
  else checkLastStanding(s);
}

// ---------------------------------------------------------------------------
// timeout & pause
// ---------------------------------------------------------------------------
function doPause(s, pid, on, now) {
  if (pid !== s.hostId) return err('host only');
  s.paused = on;
  if (on) { s.turn.deadline = null; log(s, 'Game paused by host.'); }
  else { touchDeadline(s, now); if (s.pending && s.pending.kind === 'auction') s.pending.deadline = now + AUCTION_SECS * 1000; log(s, 'Game resumed.'); }
}
function doTimeout(s, pid, now) {
  // anyone may invoke; server validates a real deadline has passed
  if (s.paused) return err('paused');
  if (s.pending && s.pending.kind === 'auction' && s.pending.deadline && now > s.pending.deadline) {
    // current high bidder wins; or fold remaining undecided as passes
    var au = s.pending;
    if (!au.high) { au.active = []; }
    else { au.active = [au.high.id]; }
    resolveAuctionIfDone(s, now);
    return;
  }
  if (s.vote && s.vote.deadline && now > s.vote.deadline) { log(s, 'Vote timed out.'); s.vote = null; return; }
  if (s.turn.deadline && now > s.turn.deadline) return autoResolveTurn(s, now);
  return err('nothing has timed out');
}
function autoResolveTurn(s, now) {
  var p = active(s);
  log(s, p.name + ' ran out of time — auto-resolving.');
  if (s.turn.debt) { bankrupt(s, p, s.turn.debt.creditor); s.turn.debt = null; if (!checkLastStanding(s)) advanceTurn(s, now); return; }
  if (s.turn.awaitingBuy != null) return doDecline(s, p.id, now);
  if (s.turn.phase === 'roll') { if (p.inJail) return doJailRoll(s, p.id, now); return doRoll(s, p.id, now); }
  if (s.turn.phase === 'end') return advanceTurn(s, now);
  touchDeadline(s, now);
}

// ---------------------------------------------------------------------------
// end conditions
// ---------------------------------------------------------------------------
function checkLastStanding(s) {
  if (s.phase !== 'playing') return s.phase === 'ended';
  var alive = alivePlayers(s);
  if (alive.length <= 1) { endGame(s, alive[0] ? alive[0].id : null, 'last player standing'); return true; }
  return false;
}
function endByNetWorth(s) {
  var alive = alivePlayers(s).slice().sort(function (a, b) { return netWorth(s, b) - netWorth(s, a); });
  endGame(s, alive[0] ? alive[0].id : null, 'round limit reached — richest wins');
}
function endGame(s, winnerId, reason) {
  s.phase = 'ended'; s.winnerId = winnerId; s.endReason = reason;
  s.turn.deadline = null;
  var w = winnerId ? player(s, winnerId) : null;
  log(s, 'Game over — ' + (w ? w.name + ' wins!' : 'no winner') + ' (' + reason + ')');
}

module.exports = { createGame: createGame, apply: apply, netWorth: netWorth, BOARD: BOARD };
