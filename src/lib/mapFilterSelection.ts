import type { ImportPlayerOption, MapFilters } from '../types/domain';

export function normalizeFilterSelection(value: unknown): string[] {
  const values =
    typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return Array.from(
    new Set(
      values
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function reconcilePlayerSelections(
  filters: MapFilters,
  players: ImportPlayerOption[],
): MapFilters {
  const availableTeams = new Set(
    players
      .filter((player) => player.steamid64)
      .map((player) => player.team_name),
  );
  const teams = (filters.thrower_team ?? []).filter((team) =>
    availableTeams.has(team),
  );
  const availablePlayers = new Set(
    players
      .filter((player) => !teams.length || teams.includes(player.team_name))
      .map((player) => player.steamid64),
  );
  const steamIds = (filters.thrower_steamid64 ?? []).filter((id) =>
    availablePlayers.has(id),
  );
  if (
    teams.length === (filters.thrower_team ?? []).length &&
    steamIds.length === (filters.thrower_steamid64 ?? []).length
  )
    return filters;
  return { ...filters, thrower_team: teams, thrower_steamid64: steamIds };
}
