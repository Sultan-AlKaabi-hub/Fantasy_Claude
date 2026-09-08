/**
 * world1.js — the vertical-slice level "The Pilgrim's Road".
 *
 * Three zones laid out left → right (see ZONES in level.js):
 *   Vesper Market  (x   0– 79)  warm sandstone, awnings, lanterns   — tutorial & husks
 *   Sunken Chapel  (x  80–151)  blue-violet ruins over water        — arches, wall-jump chimney
 *   Crimson Keep   (x 152–231)  red brick over lava, the bone king   — zealots, spikes, the gate
 *
 * Coordinates are in tiles. Rows grow downward; row 25 is the "street level"
 * of the market and the viewport shows 15 rows, so the camera usually frames
 * rows 10–25. Every gap is ≤ 5 tiles (a full jump clears 6) unless a dash or
 * wall jump is the intended solution, which is called out in comments.
 */
import { LevelBuilder } from './level.js';

export function buildWorld1() {
  const W = 232, H = 30;
  const B = new LevelBuilder(W, H);

  /* ===================== ZONE A — VESPER MARKET ===================== */
  B.fill(0, 0, 1, H - 1);                     // left boundary wall
  B.ground(2, 30, 25);
  B.player(5, 24);
  B.platform(10, 13, 21).shard('a1', 11, 20);
  B.husk(24, 24, 15, 29);                    // patrols well clear of the spawn
  B.decor('stall', 7, 24).decor('lantern', 14, 24).decor('stall', 24, 24, { flip: true })
   .decor('banner', 20, 24).decor('crates', 28, 24);

  // First pit: spikes, with a stone floor beneath so a fall is survivable.
  B.ground(31, 34, 28).spikes(31, 34, 27);

  B.ground(35, 56, 25);
  B.platform(40, 44, 21).platform(47, 50, 17).shard('a2', 48, 16);
  B.husk(45, 24, 36, 55);
  B.decor('lantern', 38, 24).decor('stall', 52, 24).decor('banner', 42, 24).decor('crates', 55, 24);

  // Second pit with a one-way bridge over it (optional safe route).
  B.ground(57, 60, 28).spikes(57, 60, 27).platform(57, 60, 22);

  B.ground(61, 79, 25);
  B.checkpoint('market', 64, 24);
  B.platform(66, 67, 21);                     // helper step toward the tall wall
  B.fill(69, 19, 79, 24);                     // 6-tile wall → one wall jump to climb (top row 19)
  B.zealot(76, 18, 70, 79);                   // guards the road east
  B.decor('lantern', 72, 18).decor('banner', 78, 18);

  /* ===================== ZONE B — SUNKEN CHAPEL ===================== */
  B.hazard(80, 151, 27);                      // deep water
  B.fill(80, 19, 86, 24);                     // plateau continues from the market wall
  B.decor('arch', 82, 18).decor('statue', 85, 18);
  B.platform(89, 92, 19).platform(95, 98, 16);
  B.fill(101, 14, 106, 24);                   // bridge pier
  B.husk(103, 13, 101, 106);
  B.decor('lantern', 104, 13);
  B.platform(109, 112, 18).shard('b1', 110, 16);
  B.fill(115, 20, 124, 24);                   // low island
  B.zealot(119, 19, 115, 124);
  B.decor('statue', 116, 19).decor('arch', 121, 19);

  // Wall-jump chimney: floating left wall, grounded right wall, 4-tile gap.
  B.fill(129, 22, 132, 24);                   // landing pad below the chimney
  B.fill(127, 10, 128, 18);                   // left wall (floating)
  B.fill(133, 10, 134, 24);                   // right wall (grounded)
  B.shard('b2', 130, 12);
  B.fill(135, 12, 151, 24);                   // upper plateau
  B.checkpoint('chapel', 138, 11);
  B.husk(145, 11, 136, 150);
  B.decor('arch', 141, 11).decor('lantern', 149, 11);

  /* ===================== ZONE C — CRIMSON KEEP ====================== */
  B.hazard(152, 231, 27);                     // lava
  B.fill(152, 12, 158, 24);
  B.decor('banner', 153, 11).decor('skull', 157, 11);
  B.fill(160, 16, 165, 24).fill(167, 20, 172, 24);   // stairs down
  B.ground(174, 185, 24).spikes(178, 179, 23);
  B.zealot(182, 23, 174, 185);
  B.decor('lantern', 176, 23);
  B.platform(187, 188, 20);                   // over lava
  B.fill(190, 18, 199, 24);
  B.checkpoint('keep', 191, 17);
  B.husk(194, 17, 190, 199).husk(198, 17, 190, 199);
  B.decor('skull', 196, 17);
  // 4-tile lava gap (200–203) then the last court.
  B.fill(204, 20, 214, 24);
  B.zealot(209, 19, 204, 214);
  B.decor('banner', 205, 19).decor('lantern', 213, 19);
  B.fill(216, 16, 229, 24);                   // gate court
  B.shard('c1', 222, 15);
  B.decor('lantern', 218, 15).decor('lantern', 228, 15);
  B.goal(225, 15);
  B.fill(230, 0, 231, H - 1);                 // right boundary wall

  return B.build();
}
