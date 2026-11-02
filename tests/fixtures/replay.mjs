// Deterministic replay data for UI regressions without a parser or private demo.
const tickrate = 64;
const player = (index) => ({
  id: String(index + 1),
  steamid64: String(index + 1),
  name: `Player ${index + 1}`,
  side: index < 5 ? 'T' : 'CT',
  team_name: index < 5 ? 'Team T' : 'Team CT',
  x: -1800 + (index % 5) * 120,
  y: index < 5 ? -1600 : 400,
  z: 0,
  yaw: index * 30,
  pitch: 0,
  alive: true,
  health: 100,
  armor: 100,
  money: 800,
  active_weapon: 'glock',
  weapons: [
    { name: 'glock', type: 'Pistol', ammo_in_magazine: 20, ammo_reserve: 120 },
  ],
  equipment_value: 1000,
  has_helmet: true,
  has_defuse_kit: index >= 5,
  flashed: false,
  kills: 0,
  assists: 0,
  deaths: 0,
});
const players = Array.from({ length: 10 }, (_, index) => player(index));

function makeRound(number) {
  const start = number === 0 ? 0 : 1024 + (number - 1) * 16000;
  const freeze = start + 15 * tickrate;
  const end = number === 0 ? 64 : freeze + 95 * tickrate;
  const event = (seconds, type, extra = {}) => ({
    tick: freeze + seconds * tickrate,
    round_number: number,
    type,
    message: '',
    x: -1800,
    y: -1200,
    z: 0,
    ...extra,
  });
  const grenades =
    number === 0
      ? []
      : [8, 40, 55, 65].map((seconds, index) => ({
          id: `${number}-${index}`,
          round_number: number,
          release_tick: freeze + seconds * tickrate,
          data: {
            grenade_type: ['smoke', 'flash', 'he', 'molotov'][index],
            thrower: players[index].name,
            thrower_steamid64: players[index].steamid64,
            thrower_team: 'Team T',
            side: 'T',
            round_time_seconds: 115 - seconds,
            throw_tick: freeze + seconds * tickrate,
            throw_keys: 'W + JUMP + MOUSE1',
            coordinates: 'setpos -1800 -1600 0; setang 0 90 0',
            airtime: 1.5,
            trajectory: Array.from({ length: 25 }, (_, point) => [
              -1800 + point * 12,
              -1600 + point * 15,
              0,
            ]),
          },
        }));
  const events =
    number === 0
      ? []
      : [20, 45, 60, 70, 80].map((seconds, index) =>
          event(seconds, 'kill', {
            player_id: '1',
            target_id: String(index + 6),
            side: 'T',
            message: `Player 1 killed Player ${index + 6}`,
            data: { weapon: 'glock', headshot: true },
          }),
        );
  if (number === 3) {
    events.push(
      event(50, 'bomb_planted', {
        message: 'A',
        data: { duration_seconds: 40 },
      }),
    );
    events.push(event(85, 'bomb_defused'));
  }
  events.sort((a, b) => a.tick - b.tick);
  const frames = [];
  for (let tick = start; tick <= end; tick += 4) {
    frames.push({
      tick,
      round_number: number,
      players: players.map((p) => {
        const dead = events.some(
          (e) => e.type === 'kill' && e.target_id === p.id && e.tick <= tick,
        );
        return {
          ...p,
          x: p.x + Math.max(0, tick - freeze) / tickrate,
          alive: !dead,
          health: dead ? 0 : 100,
        };
      }),
      projectiles: grenades.flatMap((g) => {
        const age = tick - g.release_tick;
        if (age < 0 || age > 96) return [];
        const [x, y, z] = g.data.trajectory[Math.min(24, age / 4)];
        return [
          { id: g.id, type: g.data.grenade_type, thrower_id: '1', x, y, z },
        ];
      }),
      infernos: [],
      bomb:
        number === 3 && tick >= freeze + 50 * tickrate
          ? {
              x: -1800,
              y: -1200,
              z: 0,
              state: tick < freeze + 85 * tickrate ? 'planted' : 'defused',
              site: 'A',
              carrier_id: '',
            }
          : null,
    });
  }
  return {
    type: 'round',
    round_number: number,
    round: {
      number,
      start_tick: start,
      freeze_end_tick: number === 0 ? null : freeze,
      end_tick: end,
      duration_seconds: 115,
      winner_side: number === 0 ? '' : number === 3 ? 'CT' : 'T',
      reason: number === 3 ? 'bomb_defused' : 't_win',
      score_t: Math.max(0, number - 1),
      score_ct: 0,
    },
    frames,
    events,
    grenades,
  };
}

export const rounds = [0, 1, 2, 3].map(makeRound);
export const metadata = {
  map: 'Mirage',
  demo_filename: 'replay-regression.dem',
  tickrate,
  sample_fps: 16,
  start_tick: 0,
  end_tick: rounds.at(-1).frames.at(-1).tick,
  team_t: 'Team T',
  team_ct: 'Team CT',
  parsed_at: '2026-01-01T00:00:00Z',
  frame_count: rounds.reduce((count, r) => count + r.frames.length, 0),
  round_count: 3,
};
