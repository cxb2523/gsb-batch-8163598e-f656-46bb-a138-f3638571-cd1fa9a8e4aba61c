'use strict';
// A tiny deterministic world used instead of src/data.json (3,424 provinces)
// so the logic tests stay fast and fully under our control.
//
// Layout (A = player "Avalon", B = rival "Brunia"):
//
//   0---1---2---3
//   |   |   |   |
//   4---5---6---7
//
// 0,1,4,5 belong to A; 2,3,6,7 belong to B. In war, province 1 and 5 are
// A's front line (they touch B's 2 and 6); 5 borders 6 directly, which gives
// an instant-reinforcement route from 4 into 5.

const NC = 2, NP = 8;
const adj = [
  [1, 4],       // 0
  [0, 2, 5],    // 1
  [1, 3, 6],    // 2
  [2, 7],       // 3
  [0, 5],       // 4
  [4, 6, 1],    // 5
  [5, 7, 2],    // 6
  [6, 3]        // 7
];
const owner0 = [0, 0, 1, 1, 0, 0, 1, 1];
const names = ['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'B6', 'B7'];

function buildData() {
  const prov = [];
  for (let i = 0; i < NP; i++) {
    const col = i % 4, row = Math.floor(i / 4);
    prov.push([
      owner0[i],          // r (region index == owner for this simple world)
      col * 100,          // sx
      row * 100,          // sy
      col * 100 + 50,     // x
      row * 100 + 50,     // y
      1.0,                // pop0 (millions)
      50,                 // eco
      100,                // area
      30                  // rad
    ]);
  }
  const regions = [];
  for (let c = 0; c < NC; c++) {
    regions.push({
      o: c,
      name: c === 0 ? 'Avalon' : 'Brunia',
      polys: [[[0, 0], [400, 0], [400, 200], [0, 200]]]
    });
  }
  return {
    W: 400, H: 200,
    countries: [
      { id: 'AZE', name: 'Avalon', color: '#3a6ea5', cap: 0, capName: 'Avalon City', pop: 4, gdp: 400, mil: 1 },
      { id: 'BRU', name: 'Brunia', color: '#a53a3a', cap: 3, capName: 'Brun Keep', pop: 4, gdp: 400, mil: 1 }
    ],    prov,
    adj,
    sea: [],
    lanes: [],
    regions,
    names
  };
}

module.exports = { buildData, NC, NP, adj, owner0, names };
