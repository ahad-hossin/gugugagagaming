/* ==========================================================================
   boarddata.js — Static board definition + card decks for TYCOON.
   The SINGLE source of board truth. Dual-exported so the browser client and
   the Node serverless rules engine consume identical data:
     • browser : window.MONO.board
     • node    : require('.../boarddata.js')
   Original street names + recolored groups (public-domain mechanics only).
   ==========================================================================

   Tile shape:
     { i, type, name, group?, price?, rent?, house?, mortgage?, amount? }
   types: 'go' 'street' 'rail' 'utility' 'chance' 'chest' 'tax' 'jail'
          'parking' 'gotojail'
   rent[] convention for streets: [base, 1house, 2house, 3house, 4house, hotel]
   rail rent is by count owned: RAIL_RENT[count-1]
   utility rent is multiplier × dice: UTIL_MULT[countOwned-1] × diceTotal
   ========================================================================== */
(function (root) {
  'use strict';

  var STARTING_CASH = 1500;
  var GO_SALARY = 200;
  var JAIL_INDEX = 10;        // Jail / Just-Visiting tile
  var GOTO_JAIL_INDEX = 30;
  var JAIL_FINE = 50;
  var HOUSES_SUPPLY = 32;
  var HOTELS_SUPPLY = 12;
  var RAIL_RENT = [25, 50, 100, 200];
  var UTIL_MULT = [4, 10];

  // 8 color groups + railroads + utilities. Colors tuned for the neon-glass
  // theme; `pattern` gives a colour-blind-safe shape per group.
  var GROUPS = {
    brown:     { name: 'Harbour',   color: '#9b6a4a', house: 50,  pattern: 'dots',    members: [1, 3] },
    lightblue: { name: 'Riverside', color: '#6fd3ff', house: 50,  pattern: 'lines',   members: [6, 8, 9] },
    pink:      { name: 'Marina',    color: '#ff7ad9', house: 100, pattern: 'cross',    members: [11, 13, 14] },
    orange:    { name: 'Foundry',   color: '#ff9f43', house: 100, pattern: 'grid',     members: [16, 18, 19] },
    red:       { name: 'Crimson',   color: '#ff4d5e', house: 150, pattern: 'diag',     members: [21, 23, 24] },
    yellow:    { name: 'Goldfield', color: '#ffd23d', house: 150, pattern: 'dots',     members: [26, 27, 29] },
    green:     { name: 'Emerald',   color: '#3ddc84', house: 200, pattern: 'lines',    members: [31, 32, 34] },
    darkblue:  { name: 'Skyline',   color: '#5a7dff', house: 200, pattern: 'cross',    members: [37, 39] },
    rail:      { name: 'Transit',   color: '#c9d6e6', house: 0,   pattern: 'rail',     members: [5, 15, 25, 35] },
    utility:   { name: 'Utilities', color: '#b8a6ff', house: 0,   pattern: 'bolt',     members: [12, 28] }
  };

  // Helpers to keep the table compact and unambiguous.
  function street(i, name, group, price, rent, house, mortgage) {
    return { i: i, type: 'street', name: name, group: group, price: price,
             rent: rent, house: house, mortgage: mortgage };
  }
  function rail(i, name) {
    return { i: i, type: 'rail', name: name, group: 'rail', price: 200, mortgage: 100 };
  }
  function util(i, name) {
    return { i: i, type: 'utility', name: name, group: 'utility', price: 150, mortgage: 75 };
  }

  var TILES = [
    { i: 0,  type: 'go',       name: 'GO' },
    street(1,  'Old Wharf Way',     'brown',     60,  [2, 10, 30, 90, 160, 250],     50, 30),
    { i: 2,  type: 'chest',    name: 'Community Chest' },
    street(3,  "Tanner's Row",      'brown',     60,  [4, 20, 60, 180, 320, 450],    50, 30),
    { i: 4,  type: 'tax',      name: 'Income Tax', amount: 200 },
    rail(5,  'North Dock Line'),
    street(6,  'Maple Crossing',    'lightblue', 100, [6, 30, 90, 270, 400, 550],    50, 50),
    { i: 7,  type: 'chance',   name: 'Chance' },
    street(8,  'Birch Avenue',      'lightblue', 100, [6, 30, 90, 270, 400, 550],    50, 50),
    street(9,  'Cedar Court',       'lightblue', 120, [8, 40, 100, 300, 450, 600],   50, 60),
    { i: 10, type: 'jail',     name: 'Jail / Just Visiting' },
    street(11, 'Sunset Boulevard',  'pink',      140, [10, 50, 150, 450, 625, 750],  100, 70),
    util(12, 'Power Plant'),
    street(13, 'Marina Drive',      'pink',      140, [10, 50, 150, 450, 625, 750],  100, 70),
    street(14, 'Coral Way',         'pink',      160, [12, 60, 180, 500, 700, 900],  100, 80),
    rail(15, 'East Bay Line'),
    street(16, 'Granite Street',    'orange',    180, [14, 70, 200, 550, 750, 950],  100, 90),
    { i: 17, type: 'chest',    name: 'Community Chest' },
    street(18, 'Foundry Lane',      'orange',    180, [14, 70, 200, 550, 750, 950],  100, 90),
    street(19, 'Ironworks Road',    'orange',    200, [16, 80, 220, 600, 800, 1000], 100, 100),
    { i: 20, type: 'parking',  name: 'Free Parking' },
    street(21, 'Crimson Heights',   'red',       220, [18, 90, 250, 700, 875, 1050], 150, 110),
    { i: 22, type: 'chance',   name: 'Chance' },
    street(23, 'Ruby Plaza',        'red',       220, [18, 90, 250, 700, 875, 1050], 150, 110),
    street(24, 'Garnet Avenue',     'red',       240, [20, 100, 300, 750, 925, 1100], 150, 120),
    rail(25, 'South Port Line'),
    street(26, 'Sunflower Street',  'yellow',    260, [22, 110, 330, 800, 975, 1150], 150, 130),
    street(27, 'Amber Lane',        'yellow',    260, [22, 110, 330, 800, 975, 1150], 150, 130),
    util(28, 'Water Works'),
    street(29, 'Goldenrod Way',     'yellow',    280, [24, 120, 360, 850, 1025, 1200], 150, 140),
    { i: 30, type: 'gotojail', name: 'Go To Jail' },
    street(31, 'Emerald Parkway',   'green',     300, [26, 130, 390, 900, 1100, 1275], 200, 150),
    street(32, 'Jade Boulevard',    'green',     300, [26, 130, 390, 900, 1100, 1275], 200, 150),
    { i: 33, type: 'chest',    name: 'Community Chest' },
    street(34, 'Pine Summit',       'green',     320, [28, 150, 450, 1000, 1200, 1400], 200, 160),
    rail(35, 'West End Line'),
    { i: 36, type: 'chance',   name: 'Chance' },
    street(37, 'Skyline Terrace',   'darkblue',  350, [35, 175, 500, 1100, 1300, 1500], 200, 175),
    { i: 38, type: 'tax',      name: 'Luxury Tax', amount: 100 },
    street(39, 'Summit Crown',      'darkblue',  400, [50, 200, 600, 1400, 1700, 2000], 200, 200)
  ];

  // --- Card decks --------------------------------------------------------------
  // action kinds the engine interprets:
  //   move(to,[awardGo])  moveBy(n)  back(n)  goToJail  getOut
  //   cash(amount)        collectEach(amount)  payEach(amount)
  //   nearestRail(payMult)  nearestUtility(payMult)
  //   repairs(perHouse,perHotel)
  var CHANCE = [
    { text: 'Advance to GO. Collect $200.', action: { kind: 'move', to: 0 } },
    { text: 'Advance to Skyline Terrace.',  action: { kind: 'move', to: 37 } },
    { text: 'Advance to Granite Street. If you pass GO, collect $200.', action: { kind: 'move', to: 16 } },
    { text: 'Advance to the nearest Transit line. Pay double the usual rent if owned.', action: { kind: 'nearestRail' } },
    { text: 'Advance to the nearest Utility. Pay 10× your dice if owned.', action: { kind: 'nearestUtility' } },
    { text: 'Bank pays you a dividend of $50.', action: { kind: 'cash', amount: 50 } },
    { text: 'Get Out of Jail Free. Keep this card.', action: { kind: 'getOut' } },
    { text: 'Go back 3 spaces.', action: { kind: 'back', n: 3 } },
    { text: 'Go to Jail. Do not pass GO, do not collect $200.', action: { kind: 'goToJail' } },
    { text: 'Make general repairs: $25 per house, $100 per hotel.', action: { kind: 'repairs', perHouse: 25, perHotel: 100 } },
    { text: 'Speeding fine. Pay $15.', action: { kind: 'cash', amount: -15 } },
    { text: 'Advance to North Dock Line. If you pass GO, collect $200.', action: { kind: 'move', to: 5 } },
    { text: 'You have been elected chairman. Pay each player $50.', action: { kind: 'payEach', amount: 50 } },
    { text: 'Your investment matures. Collect $150.', action: { kind: 'cash', amount: 150 } },
    { text: 'Advance to Sunset Boulevard. If you pass GO, collect $200.', action: { kind: 'move', to: 11 } },
    { text: 'A windfall! Collect $100.', action: { kind: 'cash', amount: 100 } }
  ];

  var CHEST = [
    { text: 'Advance to GO. Collect $200.', action: { kind: 'move', to: 0 } },
    { text: 'Bank error in your favour. Collect $200.', action: { kind: 'cash', amount: 200 } },
    { text: "Doctor's fee. Pay $50.", action: { kind: 'cash', amount: -50 } },
    { text: 'From sale of stock you get $50.', action: { kind: 'cash', amount: 50 } },
    { text: 'Get Out of Jail Free. Keep this card.', action: { kind: 'getOut' } },
    { text: 'Go to Jail. Do not pass GO, do not collect $200.', action: { kind: 'goToJail' } },
    { text: "It's your birthday. Collect $10 from every player.", action: { kind: 'collectEach', amount: 10 } },
    { text: 'Holiday fund matures. Collect $100.', action: { kind: 'cash', amount: 100 } },
    { text: 'Income tax refund. Collect $20.', action: { kind: 'cash', amount: 20 } },
    { text: 'Life insurance matures. Collect $100.', action: { kind: 'cash', amount: 100 } },
    { text: 'Hospital fees. Pay $100.', action: { kind: 'cash', amount: -100 } },
    { text: 'School fees. Pay $50.', action: { kind: 'cash', amount: -50 } },
    { text: 'Consultancy fee. Collect $25.', action: { kind: 'cash', amount: 25 } },
    { text: 'Street repairs: $40 per house, $115 per hotel.', action: { kind: 'repairs', perHouse: 40, perHotel: 115 } },
    { text: 'You won second prize in a beauty contest. Collect $10.', action: { kind: 'cash', amount: 10 } },
    { text: 'You inherit $100.', action: { kind: 'cash', amount: 100 } }
  ];

  var DATA = {
    TILES: TILES,
    GROUPS: GROUPS,
    CHANCE: CHANCE,
    CHEST: CHEST,
    CONST: {
      STARTING_CASH: STARTING_CASH,
      GO_SALARY: GO_SALARY,
      JAIL_INDEX: JAIL_INDEX,
      GOTO_JAIL_INDEX: GOTO_JAIL_INDEX,
      JAIL_FINE: JAIL_FINE,
      HOUSES_SUPPLY: HOUSES_SUPPLY,
      HOTELS_SUPPLY: HOTELS_SUPPLY,
      RAIL_RENT: RAIL_RENT,
      UTIL_MULT: UTIL_MULT
    }
  };

  // dual export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DATA;
  } else {
    root.MONO = root.MONO || {};
    root.MONO.board = DATA;
  }

})(typeof window !== 'undefined' ? window : this);
