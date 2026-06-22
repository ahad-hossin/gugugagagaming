/* ==========================================================================
   store.js — Settings + stats persistence (localStorage, with safe fallback)
   Exposed globally as window.BS.Store
   ========================================================================== */
(function (root) {
  'use strict';

  var KEY = 'battleship.settings.v1';
  var STATS_KEY = 'battleship.stats.v1';

  var DEFAULTS = {
    theme: 'abyss',         // chosen default theme (set after design panel)
    boardSize: 10,          // 8 | 10 | 12
    fleet: 'classic',       // classic | skirmish | armada
    difficulty: 'sailor',   // cadet | sailor | admiral
    sound: true,            // master sound on/off
    music: true,            // ambient bed on/off
    volume: 0.8,            // 0..1
    fireAgain: true,        // classic rule: extra shot after a hit
    abilities: true,        // ability mode (sonar / barrage / torpedo)
    reduced: false,         // accessibility: reduced motion
    playerName: 'Commander'
  };

  // in-memory fallback if localStorage is unavailable (file:// quirks, privacy)
  var mem = {};
  function safeGet(k) {
    try { return root.localStorage.getItem(k); } catch (e) { return mem[k] || null; }
  }
  function safeSet(k, v) {
    try { root.localStorage.setItem(k, v); } catch (e) { mem[k] = v; }
  }

  var Store = {
    defaults: DEFAULTS,

    load: function () {
      var raw = safeGet(KEY);
      var data = {};
      if (raw) { try { data = JSON.parse(raw) || {}; } catch (e) { data = {}; } }
      var merged = {};
      for (var k in DEFAULTS) merged[k] = (k in data) ? data[k] : DEFAULTS[k];
      return merged;
    },

    save: function (settings) {
      safeSet(KEY, JSON.stringify(settings));
    },

    // ---- lifetime stats ----
    loadStats: function () {
      var raw = safeGet(STATS_KEY);
      var base = { played: 0, won: 0, lost: 0, bestShots: null, hits: 0, shots: 0, streak: 0, bestStreak: 0 };
      if (raw) { try { var d = JSON.parse(raw); for (var k in base) if (k in d) base[k] = d[k]; } catch (e) {} }
      return base;
    },

    saveStats: function (stats) { safeSet(STATS_KEY, JSON.stringify(stats)); },

    // record a finished game; returns the updated stats object
    recordGame: function (won, shotsTaken, hits) {
      var s = this.loadStats();
      s.played++;
      s.shots += shotsTaken || 0;
      s.hits += hits || 0;
      if (won) {
        s.won++;
        s.streak++;
        if (s.streak > s.bestStreak) s.bestStreak = s.streak;
        if (shotsTaken && (s.bestShots === null || shotsTaken < s.bestShots)) s.bestShots = shotsTaken;
      } else {
        s.lost++;
        s.streak = 0;
      }
      this.saveStats(s);
      return s;
    }
  };

  root.BS = root.BS || {};
  root.BS.Store = Store;

})(typeof window !== 'undefined' ? window : this);
