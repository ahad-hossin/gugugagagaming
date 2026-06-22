/* ==========================================================================
   themes.js — Per-theme display config (copy, verbs, FX colors).
   Visual styling lives in css/themes.css; this is the text + color glue.
   Exposed globally as window.BS.THEMES (and ORDER)
   ========================================================================== */
(function (root) {
  'use strict';

  var THEMES = {
    abyss: {
      key: 'abyss',
      label: 'Abyssal Sonar',
      glyph: '◎',
      brand: 'SONAR',
      title: 'SONAR',
      tagline: 'Hunt by sound in the bioluminescent deep.',
      play: 'Dive In',
      start: 'Begin the Hunt',
      blurb: 'Audio-first. Listen for the fleet.',
      verbs: { fire: 'Ping', miss: 'lost in the dark', hit: 'contact!', sunk: 'sent to the depths' },
      turn: { you: 'Your ping', enemy: 'Enemy sweep…' },
      fx: { ping: '#2FF6E0', hit: '#FF7A33', miss: '#3A7C8C', sunk: '#E23838', flash: 'rgba(255,90,50,' }
    },
    warroom: {
      key: 'warroom',
      label: 'War Room 1962',
      glyph: '▣',
      brand: 'C-SCOPE',
      title: 'WAR ROOM',
      tagline: 'Plot the grid. Hold the line. The phosphor never sleeps.',
      play: 'Power On',
      start: 'Commit Solution',
      blurb: 'Cold War CRT plotting console.',
      verbs: { fire: 'Fire', miss: 'no contact', hit: 'TARGET HIT', sunk: 'CONTACT DESTROYED' },
      turn: { you: 'OFFICER ON DUTY', enemy: 'INCOMING…' },
      fx: { ping: '#7CFFB0', hit: '#FF6A2B', miss: '#6FE0FF', sunk: '#E01818', flash: 'rgba(224,24,24,' }
    },
    holo: {
      key: 'holo',
      label: 'Holo Command',
      glyph: '◈',
      brand: 'HOLO',
      title: 'HOLO COMMAND',
      tagline: 'Engage the grid. Command the void.',
      play: 'Initialize',
      start: 'Engage',
      blurb: 'Holographic command deck.',
      verbs: { fire: 'Fire', miss: 'no impact', hit: 'IMPACT', sunk: 'HULL DESTROYED' },
      turn: { you: 'YOUR MOVE', enemy: 'ENEMY SCAN…' },
      fx: { ping: '#3DF5FF', hit: '#FFB347', miss: '#5C7C9E', sunk: '#8A4DFF', flash: 'rgba(255,179,71,' }
    },
    origami: {
      key: 'origami',
      label: 'Origami Armada',
      glyph: '✦',
      brand: 'PAPER FLEET',
      title: 'Origami Armada',
      tagline: 'Fold your fleet. Tear theirs apart.',
      play: 'Unfold',
      start: 'Set Sail',
      blurb: 'A naval war drawn on graph paper.',
      verbs: { fire: 'Mark', miss: 'splotch', hit: 'torn!', sunk: 'crossed out' },
      turn: { you: 'Your move', enemy: 'Opponent drawing…' },
      fx: { ping: '#C9A24B', hit: '#D86A2C', miss: '#2E5A7A', sunk: '#A23B2E', flash: 'rgba(216,106,44,' }
    }
  };

  root.BS = root.BS || {};
  root.BS.THEMES = THEMES;
  root.BS.THEME_ORDER = ['abyss', 'warroom', 'holo', 'origami'];

})(typeof window !== 'undefined' ? window : this);
