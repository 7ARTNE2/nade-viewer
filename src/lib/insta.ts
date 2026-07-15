import type { GrenadePreview, SpawnPoint } from "../types/domain";

export const INSTA_LABEL = "Insta";
const INSTA_RADAR_EPSILON = 0.05;

type SpawnMapPoint = {
  x: number;
  y: number;
};

export const buildSpawnMapPoints = (spawnPoints: SpawnPoint[]) =>
  spawnPoints.reduce<SpawnMapPoint[]>((points, spawn) => {
    if (typeof spawn.map_x === "number" && typeof spawn.map_y === "number") {
      points.push({ x: spawn.map_x, y: spawn.map_y });
    }
    return points;
  }, []);

export const isInstaGrenade = (grenade: GrenadePreview, spawnMapPoints: SpawnMapPoint[]) => {
  if (typeof grenade.start_map_x !== "number" || typeof grenade.start_map_y !== "number") return false;
  return spawnMapPoints.some(
    (spawn) =>
      Math.abs(spawn.x - grenade.start_map_x!) <= INSTA_RADAR_EPSILON &&
      Math.abs(spawn.y - grenade.start_map_y!) <= INSTA_RADAR_EPSILON,
  );
};
