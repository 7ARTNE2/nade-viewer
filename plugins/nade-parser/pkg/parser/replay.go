package parser

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/golang/geo/r3"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
	msg "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/msg"

	"nadesoulpars/pkg/models"
	"nadesoulpars/pkg/utils"
)

const (
	replayNoTick  = -1 << 60
	replayMaxTick = int(^uint(0) >> 1)
)

type ReplayOptions struct {
	SampleFPS float64
}

type replayPosition struct {
	value r3.Vector
	ok    bool
}

func ParseReplayFile(path string, options ReplayOptions) (*models.ReplayFile, error) {
	if options.SampleFPS <= 0 {
		options.SampleFPS = 10
	}

	fileHash, err := sha256File(path)
	if err != nil {
		return nil, err
	}

	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("failed to open replay demo %s: %w", path, err)
	}
	defer file.Close()

	demoParser := demoinfocs.NewParser(file)
	defer demoParser.Close()

	startedAt := time.Now().UTC()
	mapName := ""
	tickRate := 64.0
	sampleInterval := 6
	lastSampleTick := replayNoTick
	currentRoundNumber := 0
	currentRoundIndex := -1
	startTick := replayMaxTick
	endTick := 0
	bombState := "unknown"
	bombSite := ""

	rounds := make([]models.ReplayRound, 0, 32)
	frames := make([]models.ReplayFrame, 0, 4096)
	replayEvents := make([]models.ReplayEvent, 0, 2048)
	roster := make(map[string]models.ReplayPlayerRoster)
	playerAttackHistory := make(map[int][]uint64)
	playerPositionHistory := make(map[int][]PositionSnapshot)
	nadeTrajectories := make(map[int64]*models.NadeTrajectory)
	airTrackers := make(map[int64]*AirTrack)
	projectileTags := make(map[int64][]string)
	fireGrenadeTypeByThrower := make(map[string]string)

	type flashEntry struct {
		attackerID      string
		attackerSteamID uint64
		tick            int
	}
	flashCache := make(map[string]flashEntry)

	demoParser.RegisterNetMessageHandler(func(serverInfo *msg.CSVCMsg_ServerInfo) {
		rawMapName := strings.TrimSpace(serverInfo.GetMapName())
		if rawMapName != "" {
			mapName = utils.GetDjangoMapName(rawMapName)
		}
	})

	updateTickRate := func() {
		rate := replaySafe(0.0, func() float64 { return demoParser.TickRate() })
		if rate > 0 {
			tickRate = rate
		}
		interval := int(math.Round(tickRate / options.SampleFPS))
		if interval < 1 {
			interval = 1
		}
		sampleInterval = interval
	}

	currentTick := func() int {
		return replaySafe(0, func() int { return demoParser.GameState().IngameTick() })
	}

	scoreFor := func(team common.Team) int {
		return replaySafe(0, func() int {
			state := demoParser.GameState().Team(team)
			if state == nil {
				return 0
			}
			return state.Score()
		})
	}

	teamNameFor := func(team common.Team) string {
		return replaySafe("", func() string {
			state := demoParser.GameState().Team(team)
			if state == nil {
				return ""
			}
			return state.ClanName()
		})
	}

	addRosterPlayer := func(player *common.Player) {
		if player == nil || !replayIsPlayingPlayer(player) {
			return
		}
		id := replayPlayerID(player)
		if id == "" {
			return
		}
		roster[id] = models.ReplayPlayerRoster{
			ID:        id,
			SteamID64: replaySafe(uint64(0), func() uint64 { return player.SteamID64 }),
			UserID:    replaySafe(0, func() int { return player.UserID }),
			EntityID:  replaySafe(0, func() int { return player.EntityID }),
			Name:      replaySafe("", func() string { return player.Name }),
			Side:      replaySide(player),
			TeamName:  replaySafe("", func() string { return player.TeamState.ClanName() }),
			IsBot:     replaySafe(false, func() bool { return player.IsBot }),
		}
	}

	eventAtPlayer := func(player *common.Player) (*float64, *float64, *float64) {
		pos := replayPlayerPosition(player)
		if !pos.ok {
			return nil, nil, nil
		}
		return replayEventCoords(pos.value)
	}

	addEvent := func(eventType string, message string, player *common.Player, target *common.Player, x *float64, y *float64, z *float64, data map[string]interface{}) {
		tick := currentTick()
		if tick < startTick {
			startTick = tick
		}
		if tick > endTick {
			endTick = tick
		}
		addRosterPlayer(player)
		addRosterPlayer(target)
		side := replaySide(player)
		replayEvents = append(replayEvents, models.ReplayEvent{
			Tick:            tick,
			RoundNumber:     currentRoundNumber,
			Type:            eventType,
			Message:         message,
			Side:            side,
			PlayerSteamID64: replaySafe(uint64(0), func() uint64 { return player.SteamID64 }),
			PlayerID:        replayPlayerID(player),
			TargetSteamID64: replaySafe(uint64(0), func() uint64 { return target.SteamID64 }),
			TargetID:        replayPlayerID(target),
			X:               x,
			Y:               y,
			Z:               z,
			Data:            data,
		})
	}

	addGrenadeEvent := func(eventType string, base events.GrenadeEvent) {
		x, y, z := replayEventCoords(base.Position)
		weaponName := replayEquipmentTypeName(base.GrenadeType)
		addEvent(eventType, strings.TrimSpace(weaponName+" "+eventType), base.Thrower, nil, x, y, z, map[string]interface{}{
			"grenade_type":      weaponName,
			"grenade_entity_id": base.GrenadeEntityID,
		})
	}

	demoParser.RegisterEventHandler(func(e events.RoundStart) {
		updateTickRate()
		clear(fireGrenadeTypeByThrower)
		currentRoundNumber++
		currentRoundIndex = len(rounds)
		tick := currentTick()
		if tick < startTick {
			startTick = tick
		}
		rounds = append(rounds, models.ReplayRound{
			Number:    currentRoundNumber,
			StartTick: tick,
			ScoreT:    scoreFor(common.TeamTerrorists),
			ScoreCT:   scoreFor(common.TeamCounterTerrorists),
		})
		bombState = "unknown"
		bombSite = ""
		addEvent("round_start", "Round started", nil, nil, nil, nil, nil, map[string]interface{}{
			"time_limit": e.TimeLimit,
			"frag_limit": e.FragLimit,
			"objective":  e.Objective,
		})
	})

	demoParser.RegisterEventHandler(func(e events.RoundFreezetimeEnd) {
		tick := currentTick()
		if currentRoundIndex >= 0 && currentRoundIndex < len(rounds) {
			rounds[currentRoundIndex].FreezeEndTick = replayIntPtr(tick)
		}
		addEvent("freezetime_end", "Freeze time ended", nil, nil, nil, nil, nil, nil)
	})

	demoParser.RegisterEventHandler(func(e events.RoundEnd) {
		tick := currentTick()
		if currentRoundIndex >= 0 && currentRoundIndex < len(rounds) {
			rounds[currentRoundIndex].EndTick = replayIntPtr(tick)
			rounds[currentRoundIndex].WinnerSide = replayTeamSide(e.Winner)
			rounds[currentRoundIndex].Reason = replayRoundEndReason(e.Reason)
			rounds[currentRoundIndex].ScoreT = scoreFor(common.TeamTerrorists)
			rounds[currentRoundIndex].ScoreCT = scoreFor(common.TeamCounterTerrorists)
		}
		addEvent("round_end", e.Message, nil, nil, nil, nil, nil, map[string]interface{}{
			"winner_side": replayTeamSide(e.Winner),
			"reason":      replayRoundEndReason(e.Reason),
		})
	})

	demoParser.RegisterEventHandler(func(e events.ScoreUpdated) {
		team := common.TeamUnassigned
		if e.TeamState != nil {
			team = replaySafe(common.TeamUnassigned, func() common.Team { return e.TeamState.Team() })
		}
		addEvent("score_updated", "Score updated", nil, nil, nil, nil, nil, map[string]interface{}{
			"side":      replayTeamSide(team),
			"old_score": e.OldScore,
			"new_score": e.NewScore,
		})
	})

	demoParser.RegisterEventHandler(func(e events.TeamSideSwitch) {
		addEvent("team_side_switch", "Teams switched sides", nil, nil, nil, nil, nil, nil)
	})

	demoParser.RegisterEventHandler(func(e events.GameHalfEnded) {
		addEvent("game_half_end", "Half ended", nil, nil, nil, nil, nil, nil)
	})

	demoParser.RegisterEventHandler(func(e events.Kill) {
		x, y, z := eventAtPlayer(e.Victim)
		data := map[string]interface{}{
			"weapon":             replayEquipmentName(e.Weapon),
			"assister_id":        replayPlayerID(e.Assister),
			"assister_steamid64": replaySafe(uint64(0), func() uint64 { return e.Assister.SteamID64 }),
			"headshot":           e.IsHeadshot,
			"wallbang":           e.IsWallBang(),
			"penetrated_objects": e.PenetratedObjects,
			"assisted_flash":     e.AssistedFlash,
			"attacker_blind":     e.AttackerBlind,
			"noscope":            e.NoScope,
			"through_smoke":      e.ThroughSmoke,
			"distance":           e.Distance,
			"teamkill":           replayIsTeamKill(e.Killer, e.Victim),
		}
		if e.AssistedFlash {
			victimID := replayPlayerID(e.Victim)
			if entry, ok := flashCache[victimID]; ok {
				data["flash_assister_id"] = entry.attackerID
				data["flash_assister_steamid64"] = entry.attackerSteamID
			}
		}
		addEvent("kill", replayKillMessage(e), e.Killer, e.Victim, x, y, z, data)
	})

	demoParser.RegisterEventHandler(func(e events.PlayerHurt) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("damage", replayDamageMessage(e), e.Attacker, e.Player, x, y, z, map[string]interface{}{
			"weapon":              replayEquipmentName(e.Weapon),
			"weapon_string":       e.WeaponString,
			"health":              e.Health,
			"armor":               e.Armor,
			"health_damage":       e.HealthDamage,
			"armor_damage":        e.ArmorDamage,
			"health_damage_taken": e.HealthDamageTaken,
			"armor_damage_taken":  e.ArmorDamageTaken,
			"hitgroup":            int(e.HitGroup),
		})
	})

	demoParser.RegisterEventHandler(func(e events.BulletDamage) {
		x, y, z := eventAtPlayer(e.Victim)
		addEvent("bullet_damage", "Bullet damage", e.Attacker, e.Victim, x, y, z, map[string]interface{}{
			"distance":          e.Distance,
			"damage_dir_x":      e.DamageDirX,
			"damage_dir_y":      e.DamageDirY,
			"damage_dir_z":      e.DamageDirZ,
			"num_penetrations":  e.NumPenetrations,
			"noscope":           e.IsNoScope,
			"attacker_airborne": e.IsAttackerInAir,
		})
	})

	demoParser.RegisterEventHandler(func(e events.WeaponFire) {
		x, y, z := eventAtPlayer(e.Shooter)
		addEvent("weapon_fire", replayEquipmentName(e.Weapon)+" fired", e.Shooter, nil, x, y, z, map[string]interface{}{
			"weapon": replayEquipmentName(e.Weapon),
		})
	})

	demoParser.RegisterEventHandler(func(e events.WeaponReload) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("weapon_reload", "Reload started", e.Player, nil, x, y, z, nil)
	})

	demoParser.RegisterEventHandler(func(e events.ItemEquip) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("item_equip", replayEquipmentName(e.Weapon)+" equipped", e.Player, nil, x, y, z, map[string]interface{}{"weapon": replayEquipmentName(e.Weapon)})
	})
	demoParser.RegisterEventHandler(func(e events.ItemPickup) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("item_pickup", replayEquipmentName(e.Weapon)+" picked up", e.Player, nil, x, y, z, map[string]interface{}{"weapon": replayEquipmentName(e.Weapon)})
	})
	demoParser.RegisterEventHandler(func(e events.ItemDrop) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("item_drop", replayEquipmentName(e.Weapon)+" dropped", e.Player, nil, x, y, z, map[string]interface{}{"weapon": replayEquipmentName(e.Weapon)})
	})
	demoParser.RegisterEventHandler(func(e events.ItemRefund) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("item_refund", replayEquipmentName(e.Weapon)+" refunded", e.Player, nil, x, y, z, map[string]interface{}{"weapon": replayEquipmentName(e.Weapon)})
	})

	demoParser.RegisterEventHandler(func(e events.GrenadeProjectileThrow) {
		projectile := e.Projectile
		if projectile == nil || projectile.Thrower == nil {
			return
		}

		thrower := projectile.Thrower
		weapon := projectile.WeaponInstance

		tags := []string{}
		grenadeType := ""
		if weapon != nil {
			grenadeType = utils.GetDjangoGrenadeType(weapon.Type.String())
		} else {
			grenadeType = replayGrenadeTypeFromProjectile(projectile)
			tags = append(tags, "fail")
		}
		if fireGrenadeType := replayFireGrenadeType(weapon); fireGrenadeType != "" {
			fireGrenadeTypeByThrower[replayPlayerID(thrower)] = fireGrenadeType
		}

		tick := currentTick()
		updateTickRate()

		attackHistory := appendCurrentButtons(playerAttackHistory[thrower.EntityID], thrower.ButtonsPressedState)
		posHistory := appendCurrentPosition(
			playerPositionHistory[thrower.EntityID],
			tick,
			replaySafe(r3.Vector{}, func() r3.Vector { return thrower.Position() }),
			float64(replaySafe(float32(0), func() float32 { return thrower.ViewDirectionY() })),
			float64(replaySafe(float32(0), func() float32 { return thrower.ViewDirectionX() })),
		)

		rawThrowDesc := getThrowKeys(thrower, attackHistory)
		// Броски в движении больше НЕ помечаются "fail": новый алгоритм
		// (resolveGrenadeLineupV2) корректно вычисляет их точку броска.
		// Тег "fail" остаётся только для битых гранат (weapon == nil).
		throwDesc := normalizeThrowKeys(attackHistory, posHistory, rawThrowDesc)

		startTick := tick
		if hasThrowModifier(throwDesc, "W") && hasThrowModifier(throwDesc, "JUMP") {
			startTick = tick - 11
		} else if hasThrowModifier(throwDesc, "JUMP") && !hasThrowModifier(throwDesc, "W") {
			startTick = tick - 15
		}

		var startPosOverride *models.TrajectoryPoint
		var lineupSnapshot *PositionSnapshot
		if len(tags) > 0 {
			lineupSnapshot = findThrowReleaseSnapshot(attackHistory, posHistory, tick)
		} else {
			startPosOverride, lineupSnapshot = resolveGrenadeLineupV2(attackHistory, posHistory, throwDesc, tick, startTick)
		}

		playerState := getPlayerState(thrower, throwDesc, startPosOverride, lineupSnapshot)

		var throwerEntityID *int
		if pawnEntity := thrower.PlayerPawnEntity(); pawnEntity != nil {
			idx := int(pawnEntity.ID())
			throwerEntityID = &idx
		}

		trajectory := &models.NadeTrajectory{
			UniqueID:        projectile.UniqueID(),
			WeaponType:      grenadeType,
			ThrowerSteamID:  int64(thrower.SteamID64),
			ThrowerName:     thrower.Name,
			ThrowerTeam:     thrower.TeamState.ClanName(),
			ThrowerEntityID: throwerEntityID,
			Team:            utils.GetDjangoSide(int(thrower.Team)),
			Trajectory:      make([]models.TrajectoryPoint, 0),
			StartTick:       startTick,
			PlayerState:     playerState,
			Tags:            tags,
		}

		nadeTrajectories[trajectory.UniqueID] = trajectory
		projectileTags[projectile.UniqueID()] = tags

		airTrackers[projectile.UniqueID()] = &AirTrack{
			LastPos:   r3.Vector{},
			ThrowTick: tick,
		}

		pos := replayProjectilePosition(projectile)
		x, y, z := replayOptionalCoords(pos)

		if thrower != nil && thrower.Entity != nil {
			playerAttackHistory[thrower.EntityID] = attackHistory
			playerPositionHistory[thrower.EntityID] = posHistory
		}

		coordinates := ""
		if playerState != nil && (playerState.Position.X != 0 || playerState.Position.Y != 0 || playerState.Position.Z != 0) {
			coordinates = formatCoordinates(playerState.Position, playerState.Pitch, playerState.Yaw)
		}

		data := map[string]interface{}{
			"projectile_id":     projectile.UniqueID(),
			"grenade_entity_id": replayProjectileEntityID(projectile),
			"grenade_type":      grenadeType,
			"throw_tick":        tick,
			"throw_keys":        throwDesc,
			"coordinates":       coordinates,
			"thrower_name":      replaySafe("", func() string { return thrower.Name }),
			"thrower_steamid64": int64(thrower.SteamID64),
			"thrower_entity_id": throwerEntityID,
			"tags":              tags,
		}
		addEvent("grenade_throw", grenadeType+" thrown", thrower, nil, x, y, z, data)
	})
	demoParser.RegisterEventHandler(func(e events.GrenadeProjectileBounce) {
		projectile := e.Projectile
		if projectile == nil {
			return
		}
		pos := replayProjectilePosition(projectile)
		x, y, z := replayOptionalCoords(pos)
		thrower := replaySafe((*common.Player)(nil), func() *common.Player { return projectile.Thrower })
		addEvent("grenade_bounce", replayProjectileType(projectile)+" bounced", thrower, nil, x, y, z, map[string]interface{}{
			"projectile_id": projectile.UniqueID(),
			"grenade_type":  replayProjectileType(projectile),
			"bounce_nr":     e.BounceNr,
		})
	})
	demoParser.RegisterEventHandler(func(e events.GrenadeProjectileDestroy) {
		projectile := e.Projectile
		if projectile == nil {
			return
		}

		id := projectile.UniqueID()
		trajectory, exists := nadeTrajectories[id]
		if !exists {
			return
		}

		if len(projectile.Trajectory) > 0 {
			for _, entry := range projectile.Trajectory {
				trajectory.Trajectory = append(trajectory.Trajectory, models.TrajectoryPoint{
					X: entry.Position.X,
					Y: entry.Position.Y,
					Z: entry.Position.Z,
				})
			}
		}

		trajectory.EndTick = currentTick()

		thrower := replaySafe((*common.Player)(nil), func() *common.Player { return projectile.Thrower })
		pos := replayProjectilePosition(projectile)
		x, y, z := replayOptionalCoords(pos)

		airtime := 0.0
		if trajectory.AirtimeOverride > 0 {
			airtime = trajectory.AirtimeOverride
		} else {
			ticks := trajectory.EndTick - trajectory.StartTick
			if tickRate > 0 {
				airtime = float64(ticks) / tickRate
			}
		}
		if trajectory.WeaponType == "HE" || trajectory.WeaponType == "flash" {
			airtime = 1.6
		}

		throwDescription := ""
		coordinates := ""
		if trajectory.PlayerState != nil {
			throwDescription = trajectory.PlayerState.Buttons[0]
			if trajectory.PlayerState.Position.X != 0 || trajectory.PlayerState.Position.Y != 0 || trajectory.PlayerState.Position.Z != 0 {
				coordinates = formatCoordinates(trajectory.PlayerState.Position, trajectory.PlayerState.Pitch, trajectory.PlayerState.Yaw)
			}
		}

		data := map[string]interface{}{
			"projectile_id":     id,
			"grenade_type":      trajectory.WeaponType,
			"end_tick":          trajectory.EndTick,
			"airtime":           airtime,
			"throw_keys":        throwDescription,
			"coordinates":       coordinates,
			"trajectory_points": len(trajectory.Trajectory),
		}
		addEvent("grenade_destroy", trajectory.WeaponType+" destroyed", thrower, nil, x, y, z, data)

		delete(airTrackers, id)
		delete(nadeTrajectories, id)
	})

	demoParser.RegisterEventHandler(func(e events.HeExplode) { addGrenadeEvent("he_explode", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.FlashExplode) { addGrenadeEvent("flash_explode", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.SmokeStart) { addGrenadeEvent("smoke_start", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.SmokeExpired) { addGrenadeEvent("smoke_expired", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.FireGrenadeStart) { addGrenadeEvent("fire_start", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.FireGrenadeExpired) { addGrenadeEvent("fire_expired", e.GrenadeEvent) })

	demoParser.RegisterEventHandler(func(e events.InfernoStart) {
		if e.Inferno == nil {
			return
		}
		thrower := replaySafe((*common.Player)(nil), func() *common.Player { return e.Inferno.Thrower() })
		addEvent("inferno_start", "Inferno started", thrower, nil, nil, nil, nil, map[string]interface{}{
			"inferno_id":   e.Inferno.UniqueID(),
			"grenade_type": fireGrenadeTypeByThrower[replayPlayerID(thrower)],
		})
	})
	demoParser.RegisterEventHandler(func(e events.InfernoExpired) {
		if e.Inferno == nil {
			return
		}
		thrower := replaySafe((*common.Player)(nil), func() *common.Player { return e.Inferno.Thrower() })
		addEvent("inferno_expired", "Inferno expired", thrower, nil, nil, nil, nil, map[string]interface{}{
			"inferno_id": e.Inferno.UniqueID(),
		})
	})

	demoParser.RegisterEventHandler(func(e events.PlayerFlashed) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("player_flashed", "Player flashed", e.Attacker, e.Player, x, y, z, map[string]interface{}{
			"flash_ms": int(replaySafe(time.Duration(0), func() time.Duration { return e.FlashDuration() }).Milliseconds()),
		})
		victimID := replayPlayerID(e.Player)
		flashCache[victimID] = flashEntry{
			attackerID:      replayPlayerID(e.Attacker),
			attackerSteamID: replaySafe(uint64(0), func() uint64 { return e.Attacker.SteamID64 }),
			tick:            currentTick(),
		}
	})

	demoParser.RegisterEventHandler(func(e events.BombPlantBegin) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "planting"
		bombSite = replayBombsite(e.Site)
		addEvent("bomb_plant_begin", "Bomb plant started", e.Player, nil, x, y, z, map[string]interface{}{"site": bombSite})
	})
	demoParser.RegisterEventHandler(func(e events.BombPlantAborted) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "carried"
		addEvent("bomb_plant_aborted", "Bomb plant aborted", e.Player, nil, x, y, z, nil)
	})
	demoParser.RegisterEventHandler(func(e events.BombPlanted) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "planted"
		bombSite = replayBombsite(e.Site)
		addEvent("bomb_planted", "Bomb planted", e.Player, nil, x, y, z, map[string]interface{}{"site": bombSite})
	})
	demoParser.RegisterEventHandler(func(e events.BombDefuseStart) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("bomb_defuse_start", "Bomb defuse started", e.Player, nil, x, y, z, map[string]interface{}{"has_kit": e.HasKit})
	})
	demoParser.RegisterEventHandler(func(e events.BombDefuseAborted) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("bomb_defuse_aborted", "Bomb defuse aborted", e.Player, nil, x, y, z, nil)
	})
	demoParser.RegisterEventHandler(func(e events.BombDefused) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "defused"
		bombSite = replayBombsite(e.Site)
		addEvent("bomb_defused", "Bomb defused", e.Player, nil, x, y, z, map[string]interface{}{"site": bombSite})
	})
	demoParser.RegisterEventHandler(func(e events.BombExplode) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "exploded"
		bombSite = replayBombsite(e.Site)
		addEvent("bomb_exploded", "Bomb exploded", e.Player, nil, x, y, z, map[string]interface{}{"site": bombSite})
	})
	demoParser.RegisterEventHandler(func(e events.BombDropped) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "dropped"
		addEvent("bomb_dropped", "Bomb dropped", e.Player, nil, x, y, z, map[string]interface{}{"entity_id": e.EntityID})
	})
	demoParser.RegisterEventHandler(func(e events.BombPickup) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "carried"
		addEvent("bomb_pickup", "Bomb picked up", e.Player, nil, x, y, z, nil)
	})

	demoParser.RegisterEventHandler(func(e events.Footstep) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("footstep", "Footstep", e.Player, nil, x, y, z, nil)
	})
	demoParser.RegisterEventHandler(func(e events.PlayerSound) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("player_sound", "Player sound", e.Player, nil, x, y, z, map[string]interface{}{
			"radius":      e.Radius,
			"duration_ms": e.Duration.Milliseconds(),
		})
	})

	demoParser.RegisterEventHandler(func(e events.FrameDone) {
		updateTickRate()
		tick := currentTick()
		if tick < 0 {
			return
		}
		if tick < startTick {
			startTick = tick
		}
		if tick > endTick {
			endTick = tick
		}
		participants := replaySafe([]*common.Player(nil), func() []*common.Player {
			return demoParser.GameState().Participants().All()
		})
		for _, player := range participants {
			if player == nil || player.Entity == nil {
				continue
			}
			playerAttackHistory[player.EntityID] = appendCurrentButtons(playerAttackHistory[player.EntityID], player.ButtonsPressedState)
			playerPositionHistory[player.EntityID] = appendCurrentPosition(
				playerPositionHistory[player.EntityID],
				tick,
				replaySafe(r3.Vector{}, func() r3.Vector { return player.Position() }),
				float64(replaySafe(float32(0), func() float32 { return player.ViewDirectionY() })),
				float64(replaySafe(float32(0), func() float32 { return player.ViewDirectionX() })),
			)
		}
		if lastSampleTick != replayNoTick && tick-lastSampleTick < sampleInterval {
			return
		}
		lastSampleTick = tick

		players := make([]models.ReplayPlayerFrame, 0, len(participants))
		for _, player := range participants {
			if !replayIsPlayingPlayer(player) {
				continue
			}
			addRosterPlayer(player)
			if framePlayer, ok := replayPlayerFrame(player); ok {
				players = append(players, framePlayer)
			}
		}
		sort.Slice(players, func(i, j int) bool {
			if players[i].Side == players[j].Side {
				return players[i].Name < players[j].Name
			}
			return players[i].Side < players[j].Side
		})

		projectileMap := replaySafe(map[int]*common.GrenadeProjectile(nil), func() map[int]*common.GrenadeProjectile {
			return demoParser.GameState().GrenadeProjectiles()
		})
		projectiles := make([]models.ReplayProjectileFrame, 0, len(projectileMap))
		for _, projectile := range projectileMap {
			if frameProjectile, ok := replayProjectileFrame(projectile, projectileTags); ok {
				projectiles = append(projectiles, frameProjectile)
			}

			id := projectile.UniqueID()
			if trajectory, exists := nadeTrajectories[id]; exists {
				pp := projectile.Position()
				point := models.TrajectoryPoint{X: pp.X, Y: pp.Y, Z: pp.Z}
				if n := len(trajectory.Trajectory); n > 0 {
					last := trajectory.Trajectory[n-1]
					if !(last.X == point.X && last.Y == point.Y && last.Z == point.Z) {
						trajectory.Trajectory = append(trajectory.Trajectory, point)
					}
				} else {
					trajectory.Trajectory = append(trajectory.Trajectory, point)
				}
			}

			at := airTrackers[id]
			if at == nil || at.Done {
				continue
			}

			weapon := projectile.WeaponInstance
			if weapon == nil {
				continue
			}
			grenadeType := utils.GetDjangoGrenadeType(weapon.Type.String())
			if grenadeType == "flash" || grenadeType == "HE" {
				continue
			}

			pp := projectile.Position()
			pos := r3.Vector{X: pp.X, Y: pp.Y, Z: pp.Z}

			dist := 0.0
			if at.LastPos != (r3.Vector{}) {
				dx := pos.X - at.LastPos.X
				dy := pos.Y - at.LastPos.Y
				dz := pos.Z - at.LastPos.Z
				dist = math.Sqrt(dx*dx + dy*dy + dz*dz)
			}

			if dist > epsDist {
				at.HasMoved = true
				at.StableTicks = 0
			} else {
				if at.HasMoved {
					at.StableTicks++
				}
			}
			at.LastPos = pos

			age := tick - at.ThrowTick
			if at.HasMoved && age >= minAgeTicks && at.StableTicks >= stableNeed {
				at.Done = true
				stopTick := tick - at.StableTicks

				if trajectory, exists := nadeTrajectories[id]; exists {
					tr := tickRate
					if tr <= 0 {
						tr = 64.0
					}
					trajectory.AirtimeOverride = float64(stopTick-at.ThrowTick) / tr
				}
			}
		}
		sort.Slice(projectiles, func(i, j int) bool { return projectiles[i].ID < projectiles[j].ID })

		infernoMap := replaySafe(map[int]*common.Inferno(nil), func() map[int]*common.Inferno {
			return demoParser.GameState().Infernos()
		})
		infernos := make([]models.ReplayInfernoFrame, 0, len(infernoMap))
		for _, inferno := range infernoMap {
			if frameInferno, ok := replayInfernoFrame(inferno); ok {
				infernos = append(infernos, frameInferno)
			}
		}
		sort.Slice(infernos, func(i, j int) bool { return infernos[i].ID < infernos[j].ID })

		bomb := replaySafe((*common.Bomb)(nil), func() *common.Bomb { return demoParser.GameState().Bomb() })
		bombFrame := replayBombFrame(bomb, bombState, bombSite)

		frames = append(frames, models.ReplayFrame{
			Tick:        tick,
			RoundNumber: currentRoundNumber,
			Players:     players,
			Projectiles: projectiles,
			Infernos:    infernos,
			Bomb:        bombFrame,
		})
	})

	if err := demoParser.ParseToEnd(); err != nil {
		return nil, fmt.Errorf("failed to parse replay demo %s: %w", path, err)
	}

	if startTick == replayMaxTick {
		startTick = 0
	}
	if mapName == "" {
		mapName = "Unknown"
	}

	players := make([]models.ReplayPlayerRoster, 0, len(roster))
	for _, player := range roster {
		players = append(players, player)
	}
	sort.Slice(players, func(i, j int) bool {
		if players[i].Side == players[j].Side {
			return players[i].Name < players[j].Name
		}
		return players[i].Side < players[j].Side
	})

	for i := range rounds {
		if rounds[i].EndTick == nil {
			rounds[i].EndTick = replayIntPtr(endTick)
		}
	}

	replay := &models.ReplayFile{
		Format:  "nadegrid_replay",
		Version: 1,
		Metadata: models.ReplayMetadata{
			SourcePath:   path,
			DemoFilename: filepath.Base(path),
			FileSHA256:   fileHash,
			Map:          mapName,
			TickRate:     tickRate,
			SampleFPS:    options.SampleFPS,
			StartTick:    startTick,
			EndTick:      endTick,
			TeamT:        teamNameFor(common.TeamTerrorists),
			TeamCT:       teamNameFor(common.TeamCounterTerrorists),
			ParsedAt:     startedAt.Format(time.RFC3339),
			FrameCount:   len(frames),
			EventCount:   len(replayEvents),
			RoundCount:   len(rounds),
		},
		Players: players,
		Rounds:  rounds,
		Frames:  frames,
		Events:  replayEvents,
	}

	return replay, nil
}

func ParseReplayFileStreaming(path string, options ReplayOptions, out io.Writer) error {
	if options.SampleFPS <= 0 {
		options.SampleFPS = 10
	}

	fileHash, err := sha256File(path)
	if err != nil {
		return err
	}

	file, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("failed to open replay demo %s: %w", path, err)
	}
	defer file.Close()

	demoParser := demoinfocs.NewParser(file)
	defer demoParser.Close()

	startedAt := time.Now().UTC()
	mapName := ""
	tickRate := 64.0
	sampleInterval := 6
	lastSampleTick := replayNoTick
	currentRoundNumber := 0
	startTick := replayMaxTick
	endTick := 0
	bombState := "unknown"
	bombSite := ""

	pendingFrames := make([]models.ReplayFrame, 0, 128)
	pendingEvents := make([]models.ReplayEvent, 0, 64)
	var currentRound *models.ReplayRound
	roster := make(map[string]models.ReplayPlayerRoster)
	playerAttackHistory := make(map[int][]uint64)
	playerPositionHistory := make(map[int][]PositionSnapshot)
	nadeTrajectories := make(map[int64]*models.NadeTrajectory)
	airTrackers := make(map[int64]*AirTrack)
	projectileTags := make(map[int64][]string)
	fireGrenadeTypeByThrower := make(map[string]string)
	flushedRounds := 0
	totalFrames := 0
	totalEvents := 0

	writeJSON := func(value interface{}) error {
		data, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if _, err := out.Write(data); err != nil {
			return err
		}
		_, err = out.Write([]byte{'\n'})
		return err
	}

	flushCurrentRound := func() error {
		if currentRound == nil {
			return nil
		}
		if len(pendingFrames) == 0 && len(pendingEvents) == 0 {
			return nil
		}

		flushedRounds++
		totalFrames += len(pendingFrames)
		totalEvents += len(pendingEvents)

		line := models.ReplayStreamLine{
			Type:        "round",
			RoundNumber: currentRound.Number,
			Round:       currentRound,
			Frames:      pendingFrames,
			Events:      pendingEvents,
		}
		pendingFrames = nil
		pendingEvents = nil
		currentRound = nil
		return writeJSON(line)
	}

	type flashEntry struct {
		attackerID      string
		attackerSteamID uint64
		tick            int
	}
	flashCache := make(map[string]flashEntry)

	demoParser.RegisterNetMessageHandler(func(serverInfo *msg.CSVCMsg_ServerInfo) {
		rawMapName := strings.TrimSpace(serverInfo.GetMapName())
		if rawMapName != "" {
			mapName = utils.GetDjangoMapName(rawMapName)
		}
	})

	writeMetadata := func() error {
		line := models.ReplayStreamLine{
			Type:         "metadata",
			FileSHA256:   fileHash,
			Map:          mapName,
			SourcePath:   path,
			DemoFilename: filepath.Base(path),
			TickRate:     tickRate,
			SampleFPS:    options.SampleFPS,
			ParsedAt:     startedAt.Format(time.RFC3339),
		}
		return writeJSON(line)
	}
	metadataWritten := false

	updateTickRate := func() {
		rate := replaySafe(0.0, func() float64 { return demoParser.TickRate() })
		if rate > 0 {
			tickRate = rate
		}
		interval := int(math.Round(tickRate / options.SampleFPS))
		if interval < 1 {
			interval = 1
		}
		sampleInterval = interval
	}

	currentTick := func() int {
		return replaySafe(0, func() int { return demoParser.GameState().IngameTick() })
	}

	scoreFor := func(team common.Team) int {
		return replaySafe(0, func() int {
			state := demoParser.GameState().Team(team)
			if state == nil {
				return 0
			}
			return state.Score()
		})
	}

	teamNameFor := func(team common.Team) string {
		return replaySafe("", func() string {
			state := demoParser.GameState().Team(team)
			if state == nil {
				return ""
			}
			return state.ClanName()
		})
	}

	addRosterPlayer := func(player *common.Player) {
		if player == nil || !replayIsPlayingPlayer(player) {
			return
		}
		id := replayPlayerID(player)
		if id == "" {
			return
		}
		roster[id] = models.ReplayPlayerRoster{
			ID:        id,
			SteamID64: replaySafe(uint64(0), func() uint64 { return player.SteamID64 }),
			UserID:    replaySafe(0, func() int { return player.UserID }),
			EntityID:  replaySafe(0, func() int { return player.EntityID }),
			Name:      replaySafe("", func() string { return player.Name }),
			Side:      replaySide(player),
			TeamName:  replaySafe("", func() string { return player.TeamState.ClanName() }),
			IsBot:     replaySafe(false, func() bool { return player.IsBot }),
		}
	}

	eventAtPlayer := func(player *common.Player) (*float64, *float64, *float64) {
		pos := replayPlayerPosition(player)
		if !pos.ok {
			return nil, nil, nil
		}
		return replayEventCoords(pos.value)
	}

	addEvent := func(eventType string, message string, player *common.Player, target *common.Player, x *float64, y *float64, z *float64, data map[string]interface{}) {
		tick := currentTick()
		if tick < startTick {
			startTick = tick
		}
		if tick > endTick {
			endTick = tick
		}
		addRosterPlayer(player)
		addRosterPlayer(target)
		side := replaySide(player)
		pendingEvents = append(pendingEvents, models.ReplayEvent{
			Tick:            tick,
			RoundNumber:     currentRoundNumber,
			Type:            eventType,
			Message:         message,
			Side:            side,
			PlayerSteamID64: replaySafe(uint64(0), func() uint64 { return player.SteamID64 }),
			PlayerID:        replayPlayerID(player),
			TargetSteamID64: replaySafe(uint64(0), func() uint64 { return target.SteamID64 }),
			TargetID:        replayPlayerID(target),
			X:               x,
			Y:               y,
			Z:               z,
			Data:            data,
		})
	}

	addGrenadeEvent := func(eventType string, base events.GrenadeEvent) {
		x, y, z := replayEventCoords(base.Position)
		weaponName := replayEquipmentTypeName(base.GrenadeType)
		addEvent(eventType, strings.TrimSpace(weaponName+" "+eventType), base.Thrower, nil, x, y, z, map[string]interface{}{
			"grenade_type":      weaponName,
			"grenade_entity_id": base.GrenadeEntityID,
		})
	}

	demoParser.RegisterEventHandler(func(e events.RoundStart) {
		updateTickRate()
		clear(fireGrenadeTypeByThrower)
		if err := flushCurrentRound(); err != nil {
			panic(err)
		}
		currentRoundNumber++
		tick := currentTick()
		if tick < startTick {
			startTick = tick
		}
		currentRound = &models.ReplayRound{
			Number:    currentRoundNumber,
			StartTick: tick,
			ScoreT:    scoreFor(common.TeamTerrorists),
			ScoreCT:   scoreFor(common.TeamCounterTerrorists),
		}
		bombState = "unknown"
		bombSite = ""

		if !metadataWritten {
			if err := writeMetadata(); err != nil {
				panic(err)
			}
			metadataWritten = true
		}

		addEvent("round_start", "Round started", nil, nil, nil, nil, nil, map[string]interface{}{
			"time_limit": e.TimeLimit,
			"frag_limit": e.FragLimit,
			"objective":  e.Objective,
		})
	})

	demoParser.RegisterEventHandler(func(e events.RoundFreezetimeEnd) {
		tick := currentTick()
		if currentRound != nil {
			currentRound.FreezeEndTick = replayIntPtr(tick)
		}
		addEvent("freezetime_end", "Freeze time ended", nil, nil, nil, nil, nil, nil)
	})

	demoParser.RegisterEventHandler(func(e events.RoundEnd) {
		tick := currentTick()
		if currentRound != nil {
			currentRound.EndTick = replayIntPtr(tick)
			currentRound.WinnerSide = replayTeamSide(e.Winner)
			currentRound.Reason = replayRoundEndReason(e.Reason)
			currentRound.ScoreT = scoreFor(common.TeamTerrorists)
			currentRound.ScoreCT = scoreFor(common.TeamCounterTerrorists)
		}
		addEvent("round_end", e.Message, nil, nil, nil, nil, nil, map[string]interface{}{
			"winner_side": replayTeamSide(e.Winner),
			"reason":      replayRoundEndReason(e.Reason),
		})
	})

	demoParser.RegisterEventHandler(func(e events.ScoreUpdated) {
		team := common.TeamUnassigned
		if e.TeamState != nil {
			team = replaySafe(common.TeamUnassigned, func() common.Team { return e.TeamState.Team() })
		}
		addEvent("score_updated", "Score updated", nil, nil, nil, nil, nil, map[string]interface{}{
			"side":      replayTeamSide(team),
			"old_score": e.OldScore,
			"new_score": e.NewScore,
		})
	})

	demoParser.RegisterEventHandler(func(e events.TeamSideSwitch) {
		addEvent("team_side_switch", "Teams switched sides", nil, nil, nil, nil, nil, nil)
	})

	demoParser.RegisterEventHandler(func(e events.GameHalfEnded) {
		addEvent("game_half_end", "Half ended", nil, nil, nil, nil, nil, nil)
	})

	demoParser.RegisterEventHandler(func(e events.Kill) {
		x, y, z := eventAtPlayer(e.Victim)
		data := map[string]interface{}{
			"weapon":             replayEquipmentName(e.Weapon),
			"assister_id":        replayPlayerID(e.Assister),
			"assister_steamid64": replaySafe(uint64(0), func() uint64 { return e.Assister.SteamID64 }),
			"headshot":           e.IsHeadshot,
			"wallbang":           e.IsWallBang(),
			"penetrated_objects": e.PenetratedObjects,
			"assisted_flash":     e.AssistedFlash,
			"attacker_blind":     e.AttackerBlind,
			"noscope":            e.NoScope,
			"through_smoke":      e.ThroughSmoke,
			"distance":           e.Distance,
			"teamkill":           replayIsTeamKill(e.Killer, e.Victim),
		}
		if e.AssistedFlash {
			victimID := replayPlayerID(e.Victim)
			if entry, ok := flashCache[victimID]; ok {
				data["flash_assister_id"] = entry.attackerID
				data["flash_assister_steamid64"] = entry.attackerSteamID
			}
		}
		addEvent("kill", replayKillMessage(e), e.Killer, e.Victim, x, y, z, data)
	})

	demoParser.RegisterEventHandler(func(e events.PlayerHurt) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("damage", replayDamageMessage(e), e.Attacker, e.Player, x, y, z, map[string]interface{}{
			"weapon":              replayEquipmentName(e.Weapon),
			"weapon_string":       e.WeaponString,
			"health":              e.Health,
			"armor":               e.Armor,
			"health_damage":       e.HealthDamage,
			"armor_damage":        e.ArmorDamage,
			"health_damage_taken": e.HealthDamageTaken,
			"armor_damage_taken":  e.ArmorDamageTaken,
			"hitgroup":            int(e.HitGroup),
		})
	})

	demoParser.RegisterEventHandler(func(e events.BulletDamage) {
		x, y, z := eventAtPlayer(e.Victim)
		addEvent("bullet_damage", "Bullet damage", e.Attacker, e.Victim, x, y, z, map[string]interface{}{
			"distance":          e.Distance,
			"damage_dir_x":      e.DamageDirX,
			"damage_dir_y":      e.DamageDirY,
			"damage_dir_z":      e.DamageDirZ,
			"num_penetrations":  e.NumPenetrations,
			"noscope":           e.IsNoScope,
			"attacker_airborne": e.IsAttackerInAir,
		})
	})

	demoParser.RegisterEventHandler(func(e events.WeaponFire) {
		x, y, z := eventAtPlayer(e.Shooter)
		addEvent("weapon_fire", replayEquipmentName(e.Weapon)+" fired", e.Shooter, nil, x, y, z, map[string]interface{}{
			"weapon": replayEquipmentName(e.Weapon),
		})
	})

	demoParser.RegisterEventHandler(func(e events.WeaponReload) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("weapon_reload", "Reload started", e.Player, nil, x, y, z, nil)
	})

	demoParser.RegisterEventHandler(func(e events.ItemEquip) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("item_equip", replayEquipmentName(e.Weapon)+" equipped", e.Player, nil, x, y, z, map[string]interface{}{"weapon": replayEquipmentName(e.Weapon)})
	})
	demoParser.RegisterEventHandler(func(e events.ItemPickup) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("item_pickup", replayEquipmentName(e.Weapon)+" picked up", e.Player, nil, x, y, z, map[string]interface{}{"weapon": replayEquipmentName(e.Weapon)})
	})
	demoParser.RegisterEventHandler(func(e events.ItemDrop) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("item_drop", replayEquipmentName(e.Weapon)+" dropped", e.Player, nil, x, y, z, map[string]interface{}{"weapon": replayEquipmentName(e.Weapon)})
	})
	demoParser.RegisterEventHandler(func(e events.ItemRefund) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("item_refund", replayEquipmentName(e.Weapon)+" refunded", e.Player, nil, x, y, z, map[string]interface{}{"weapon": replayEquipmentName(e.Weapon)})
	})

	demoParser.RegisterEventHandler(func(e events.GrenadeProjectileThrow) {
		projectile := e.Projectile
		if projectile == nil || projectile.Thrower == nil {
			return
		}

		thrower := projectile.Thrower
		weapon := projectile.WeaponInstance

		tags := []string{}
		grenadeType := ""
		if weapon != nil {
			grenadeType = utils.GetDjangoGrenadeType(weapon.Type.String())
		} else {
			grenadeType = replayGrenadeTypeFromProjectile(projectile)
			tags = append(tags, "fail")
		}
		if fireGrenadeType := replayFireGrenadeType(weapon); fireGrenadeType != "" {
			fireGrenadeTypeByThrower[replayPlayerID(thrower)] = fireGrenadeType
		}

		tick := currentTick()
		updateTickRate()

		attackHistory := appendCurrentButtons(playerAttackHistory[thrower.EntityID], thrower.ButtonsPressedState)
		posHistory := appendCurrentPosition(
			playerPositionHistory[thrower.EntityID],
			tick,
			replaySafe(r3.Vector{}, func() r3.Vector { return thrower.Position() }),
			float64(replaySafe(float32(0), func() float32 { return thrower.ViewDirectionY() })),
			float64(replaySafe(float32(0), func() float32 { return thrower.ViewDirectionX() })),
		)

		rawThrowDesc := getThrowKeys(thrower, attackHistory)
		// Броски в движении больше НЕ помечаются "fail": новый алгоритм
		// (resolveGrenadeLineupV2) корректно вычисляет их точку броска.
		// Тег "fail" остаётся только для битых гранат (weapon == nil).
		throwDesc := normalizeThrowKeys(attackHistory, posHistory, rawThrowDesc)

		startTick := tick
		if hasThrowModifier(throwDesc, "W") && hasThrowModifier(throwDesc, "JUMP") {
			startTick = tick - 11
		} else if hasThrowModifier(throwDesc, "JUMP") && !hasThrowModifier(throwDesc, "W") {
			startTick = tick - 15
		}

		var startPosOverride *models.TrajectoryPoint
		var lineupSnapshot *PositionSnapshot
		if len(tags) > 0 {
			lineupSnapshot = findThrowReleaseSnapshot(attackHistory, posHistory, tick)
		} else {
			startPosOverride, lineupSnapshot = resolveGrenadeLineupV2(attackHistory, posHistory, throwDesc, tick, startTick)
		}

		playerState := getPlayerState(thrower, throwDesc, startPosOverride, lineupSnapshot)

		var throwerEntityID *int
		if pawnEntity := thrower.PlayerPawnEntity(); pawnEntity != nil {
			idx := int(pawnEntity.ID())
			throwerEntityID = &idx
		}

		trajectory := &models.NadeTrajectory{
			UniqueID:        projectile.UniqueID(),
			WeaponType:      grenadeType,
			ThrowerSteamID:  int64(thrower.SteamID64),
			ThrowerName:     thrower.Name,
			ThrowerTeam:     thrower.TeamState.ClanName(),
			ThrowerEntityID: throwerEntityID,
			Team:            utils.GetDjangoSide(int(thrower.Team)),
			Trajectory:      make([]models.TrajectoryPoint, 0),
			StartTick:       startTick,
			PlayerState:     playerState,
			Tags:            tags,
		}

		nadeTrajectories[trajectory.UniqueID] = trajectory
		projectileTags[projectile.UniqueID()] = tags

		airTrackers[projectile.UniqueID()] = &AirTrack{
			LastPos:   r3.Vector{},
			ThrowTick: tick,
		}

		pos := replayProjectilePosition(projectile)
		x, y, z := replayOptionalCoords(pos)

		if thrower != nil && thrower.Entity != nil {
			playerAttackHistory[thrower.EntityID] = attackHistory
			playerPositionHistory[thrower.EntityID] = posHistory
		}

		coordinates := ""
		if playerState != nil && (playerState.Position.X != 0 || playerState.Position.Y != 0 || playerState.Position.Z != 0) {
			coordinates = formatCoordinates(playerState.Position, playerState.Pitch, playerState.Yaw)
		}

		data := map[string]interface{}{
			"projectile_id":     projectile.UniqueID(),
			"grenade_entity_id": replayProjectileEntityID(projectile),
			"grenade_type":      grenadeType,
			"throw_tick":        tick,
			"throw_keys":        throwDesc,
			"coordinates":       coordinates,
			"thrower_name":      replaySafe("", func() string { return thrower.Name }),
			"thrower_steamid64": int64(thrower.SteamID64),
			"thrower_entity_id": throwerEntityID,
			"tags":              tags,
		}
		addEvent("grenade_throw", grenadeType+" thrown", thrower, nil, x, y, z, data)
	})
	demoParser.RegisterEventHandler(func(e events.GrenadeProjectileBounce) {
		projectile := e.Projectile
		if projectile == nil {
			return
		}
		pos := replayProjectilePosition(projectile)
		x, y, z := replayOptionalCoords(pos)
		thrower := replaySafe((*common.Player)(nil), func() *common.Player { return projectile.Thrower })
		addEvent("grenade_bounce", replayProjectileType(projectile)+" bounced", thrower, nil, x, y, z, map[string]interface{}{
			"projectile_id": projectile.UniqueID(),
			"grenade_type":  replayProjectileType(projectile),
			"bounce_nr":     e.BounceNr,
		})
	})
	demoParser.RegisterEventHandler(func(e events.GrenadeProjectileDestroy) {
		projectile := e.Projectile
		if projectile == nil {
			return
		}

		id := projectile.UniqueID()
		trajectory, exists := nadeTrajectories[id]
		if !exists {
			return
		}

		if len(projectile.Trajectory) > 0 {
			for _, entry := range projectile.Trajectory {
				trajectory.Trajectory = append(trajectory.Trajectory, models.TrajectoryPoint{
					X: entry.Position.X,
					Y: entry.Position.Y,
					Z: entry.Position.Z,
				})
			}
		}

		trajectory.EndTick = currentTick()

		thrower := replaySafe((*common.Player)(nil), func() *common.Player { return projectile.Thrower })
		pos := replayProjectilePosition(projectile)
		x, y, z := replayOptionalCoords(pos)

		airtime := 0.0
		if trajectory.AirtimeOverride > 0 {
			airtime = trajectory.AirtimeOverride
		} else {
			ticks := trajectory.EndTick - trajectory.StartTick
			if tickRate > 0 {
				airtime = float64(ticks) / tickRate
			}
		}
		if trajectory.WeaponType == "HE" || trajectory.WeaponType == "flash" {
			airtime = 1.6
		}

		throwDescription := ""
		coordinates := ""
		if trajectory.PlayerState != nil {
			throwDescription = trajectory.PlayerState.Buttons[0]
			if trajectory.PlayerState.Position.X != 0 || trajectory.PlayerState.Position.Y != 0 || trajectory.PlayerState.Position.Z != 0 {
				coordinates = formatCoordinates(trajectory.PlayerState.Position, trajectory.PlayerState.Pitch, trajectory.PlayerState.Yaw)
			}
		}

		data := map[string]interface{}{
			"projectile_id":     id,
			"grenade_type":      trajectory.WeaponType,
			"end_tick":          trajectory.EndTick,
			"airtime":           airtime,
			"throw_keys":        throwDescription,
			"coordinates":       coordinates,
			"trajectory_points": len(trajectory.Trajectory),
		}
		addEvent("grenade_destroy", trajectory.WeaponType+" destroyed", thrower, nil, x, y, z, data)

		delete(airTrackers, id)
		delete(nadeTrajectories, id)
	})

	demoParser.RegisterEventHandler(func(e events.HeExplode) { addGrenadeEvent("he_explode", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.FlashExplode) { addGrenadeEvent("flash_explode", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.SmokeStart) { addGrenadeEvent("smoke_start", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.SmokeExpired) { addGrenadeEvent("smoke_expired", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.FireGrenadeStart) { addGrenadeEvent("fire_start", e.GrenadeEvent) })
	demoParser.RegisterEventHandler(func(e events.FireGrenadeExpired) { addGrenadeEvent("fire_expired", e.GrenadeEvent) })

	demoParser.RegisterEventHandler(func(e events.InfernoStart) {
		if e.Inferno == nil {
			return
		}
		thrower := replaySafe((*common.Player)(nil), func() *common.Player { return e.Inferno.Thrower() })
		addEvent("inferno_start", "Inferno started", thrower, nil, nil, nil, nil, map[string]interface{}{
			"inferno_id":   e.Inferno.UniqueID(),
			"grenade_type": fireGrenadeTypeByThrower[replayPlayerID(thrower)],
		})
	})
	demoParser.RegisterEventHandler(func(e events.InfernoExpired) {
		if e.Inferno == nil {
			return
		}
		thrower := replaySafe((*common.Player)(nil), func() *common.Player { return e.Inferno.Thrower() })
		addEvent("inferno_expired", "Inferno expired", thrower, nil, nil, nil, nil, map[string]interface{}{
			"inferno_id": e.Inferno.UniqueID(),
		})
	})

	demoParser.RegisterEventHandler(func(e events.PlayerFlashed) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("player_flashed", "Player flashed", e.Attacker, e.Player, x, y, z, map[string]interface{}{
			"flash_ms": int(replaySafe(time.Duration(0), func() time.Duration { return e.FlashDuration() }).Milliseconds()),
		})
		victimID := replayPlayerID(e.Player)
		flashCache[victimID] = flashEntry{
			attackerID:      replayPlayerID(e.Attacker),
			attackerSteamID: replaySafe(uint64(0), func() uint64 { return e.Attacker.SteamID64 }),
			tick:            currentTick(),
		}
	})

	demoParser.RegisterEventHandler(func(e events.BombPlantBegin) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "planting"
		bombSite = replayBombsite(e.Site)
		addEvent("bomb_plant_begin", "Bomb plant started", e.Player, nil, x, y, z, map[string]interface{}{"site": bombSite})
	})
	demoParser.RegisterEventHandler(func(e events.BombPlantAborted) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "carried"
		addEvent("bomb_plant_aborted", "Bomb plant aborted", e.Player, nil, x, y, z, nil)
	})
	demoParser.RegisterEventHandler(func(e events.BombPlanted) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "planted"
		bombSite = replayBombsite(e.Site)
		addEvent("bomb_planted", "Bomb planted", e.Player, nil, x, y, z, map[string]interface{}{"site": bombSite})
	})
	demoParser.RegisterEventHandler(func(e events.BombDefuseStart) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("bomb_defuse_start", "Bomb defuse started", e.Player, nil, x, y, z, map[string]interface{}{"has_kit": e.HasKit})
	})
	demoParser.RegisterEventHandler(func(e events.BombDefuseAborted) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("bomb_defuse_aborted", "Bomb defuse aborted", e.Player, nil, x, y, z, nil)
	})
	demoParser.RegisterEventHandler(func(e events.BombDefused) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "defused"
		bombSite = replayBombsite(e.Site)
		addEvent("bomb_defused", "Bomb defused", e.Player, nil, x, y, z, map[string]interface{}{"site": bombSite})
	})
	demoParser.RegisterEventHandler(func(e events.BombExplode) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "exploded"
		bombSite = replayBombsite(e.Site)
		addEvent("bomb_exploded", "Bomb exploded", e.Player, nil, x, y, z, map[string]interface{}{"site": bombSite})
	})
	demoParser.RegisterEventHandler(func(e events.BombDropped) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "dropped"
		addEvent("bomb_dropped", "Bomb dropped", e.Player, nil, x, y, z, map[string]interface{}{"entity_id": e.EntityID})
	})
	demoParser.RegisterEventHandler(func(e events.BombPickup) {
		x, y, z := eventAtPlayer(e.Player)
		bombState = "carried"
		addEvent("bomb_pickup", "Bomb picked up", e.Player, nil, x, y, z, nil)
	})

	demoParser.RegisterEventHandler(func(e events.Footstep) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("footstep", "Footstep", e.Player, nil, x, y, z, nil)
	})
	demoParser.RegisterEventHandler(func(e events.PlayerSound) {
		x, y, z := eventAtPlayer(e.Player)
		addEvent("player_sound", "Player sound", e.Player, nil, x, y, z, map[string]interface{}{
			"radius":      e.Radius,
			"duration_ms": e.Duration.Milliseconds(),
		})
	})

	demoParser.RegisterEventHandler(func(e events.FrameDone) {
		updateTickRate()
		tick := currentTick()
		if tick < 0 {
			return
		}
		if tick < startTick {
			startTick = tick
		}
		if tick > endTick {
			endTick = tick
		}
		participants := replaySafe([]*common.Player(nil), func() []*common.Player {
			return demoParser.GameState().Participants().All()
		})
		for _, player := range participants {
			if player == nil || player.Entity == nil {
				continue
			}
			playerAttackHistory[player.EntityID] = appendCurrentButtons(playerAttackHistory[player.EntityID], player.ButtonsPressedState)
			playerPositionHistory[player.EntityID] = appendCurrentPosition(
				playerPositionHistory[player.EntityID],
				tick,
				replaySafe(r3.Vector{}, func() r3.Vector { return player.Position() }),
				float64(replaySafe(float32(0), func() float32 { return player.ViewDirectionY() })),
				float64(replaySafe(float32(0), func() float32 { return player.ViewDirectionX() })),
			)
		}
		if lastSampleTick != replayNoTick && tick-lastSampleTick < sampleInterval {
			return
		}
		lastSampleTick = tick

		players := make([]models.ReplayPlayerFrame, 0, len(participants))
		for _, player := range participants {
			if !replayIsPlayingPlayer(player) {
				continue
			}
			addRosterPlayer(player)
			if framePlayer, ok := replayPlayerFrame(player); ok {
				players = append(players, framePlayer)
			}
		}
		sort.Slice(players, func(i, j int) bool {
			if players[i].Side == players[j].Side {
				return players[i].Name < players[j].Name
			}
			return players[i].Side < players[j].Side
		})

		projectileMap := replaySafe(map[int]*common.GrenadeProjectile(nil), func() map[int]*common.GrenadeProjectile {
			return demoParser.GameState().GrenadeProjectiles()
		})
		projectiles := make([]models.ReplayProjectileFrame, 0, len(projectileMap))
		for _, projectile := range projectileMap {
			if frameProjectile, ok := replayProjectileFrame(projectile, projectileTags); ok {
				projectiles = append(projectiles, frameProjectile)
			}

			id := projectile.UniqueID()
			if trajectory, exists := nadeTrajectories[id]; exists {
				pp := projectile.Position()
				point := models.TrajectoryPoint{X: pp.X, Y: pp.Y, Z: pp.Z}
				if n := len(trajectory.Trajectory); n > 0 {
					last := trajectory.Trajectory[n-1]
					if !(last.X == point.X && last.Y == point.Y && last.Z == point.Z) {
						trajectory.Trajectory = append(trajectory.Trajectory, point)
					}
				} else {
					trajectory.Trajectory = append(trajectory.Trajectory, point)
				}
			}

			at := airTrackers[id]
			if at == nil || at.Done {
				continue
			}

			weapon := projectile.WeaponInstance
			if weapon == nil {
				continue
			}
			grenadeType := utils.GetDjangoGrenadeType(weapon.Type.String())
			if grenadeType == "flash" || grenadeType == "HE" {
				continue
			}

			pp := projectile.Position()
			pos := r3.Vector{X: pp.X, Y: pp.Y, Z: pp.Z}

			dist := 0.0
			if at.LastPos != (r3.Vector{}) {
				dx := pos.X - at.LastPos.X
				dy := pos.Y - at.LastPos.Y
				dz := pos.Z - at.LastPos.Z
				dist = math.Sqrt(dx*dx + dy*dy + dz*dz)
			}

			if dist > epsDist {
				at.HasMoved = true
				at.StableTicks = 0
			} else {
				if at.HasMoved {
					at.StableTicks++
				}
			}
			at.LastPos = pos

			age := tick - at.ThrowTick
			if at.HasMoved && age >= minAgeTicks && at.StableTicks >= stableNeed {
				at.Done = true
				stopTick := tick - at.StableTicks

				if trajectory, exists := nadeTrajectories[id]; exists {
					tr := tickRate
					if tr <= 0 {
						tr = 64.0
					}
					trajectory.AirtimeOverride = float64(stopTick-at.ThrowTick) / tr
				}
			}
		}
		sort.Slice(projectiles, func(i, j int) bool { return projectiles[i].ID < projectiles[j].ID })

		infernoMap := replaySafe(map[int]*common.Inferno(nil), func() map[int]*common.Inferno {
			return demoParser.GameState().Infernos()
		})
		infernos := make([]models.ReplayInfernoFrame, 0, len(infernoMap))
		for _, inferno := range infernoMap {
			if frameInferno, ok := replayInfernoFrame(inferno); ok {
				infernos = append(infernos, frameInferno)
			}
		}
		sort.Slice(infernos, func(i, j int) bool { return infernos[i].ID < infernos[j].ID })

		bomb := replaySafe((*common.Bomb)(nil), func() *common.Bomb { return demoParser.GameState().Bomb() })
		bombFrame := replayBombFrame(bomb, bombState, bombSite)

		pendingFrames = append(pendingFrames, models.ReplayFrame{
			Tick:        tick,
			RoundNumber: currentRoundNumber,
			Players:     players,
			Projectiles: projectiles,
			Infernos:    infernos,
			Bomb:        bombFrame,
		})
	})

	if err := demoParser.ParseToEnd(); err != nil {
		return fmt.Errorf("failed to parse replay demo %s: %w", path, err)
	}

	if err := flushCurrentRound(); err != nil {
		return err
	}

	if startTick == replayMaxTick {
		startTick = 0
	}
	if mapName == "" {
		mapName = "Unknown"
	}

	players := make([]models.ReplayPlayerRoster, 0, len(roster))
	for _, player := range roster {
		players = append(players, player)
	}
	sort.Slice(players, func(i, j int) bool {
		if players[i].Side == players[j].Side {
			return players[i].Name < players[j].Name
		}
		return players[i].Side < players[j].Side
	})

	complete := models.ReplayStreamLine{
		Type:         "complete",
		FileSHA256:   fileHash,
		Map:          mapName,
		SourcePath:   path,
		DemoFilename: filepath.Base(path),
		TickRate:     tickRate,
		SampleFPS:    options.SampleFPS,
		StartTick:    startTick,
		EndTick:      endTick,
		TeamT:        teamNameFor(common.TeamTerrorists),
		TeamCT:       teamNameFor(common.TeamCounterTerrorists),
		ParsedAt:     startedAt.Format(time.RFC3339),
		FrameCount:   totalFrames,
		EventCount:   totalEvents,
		RoundCount:   flushedRounds,
		Players:      players,
	}
	return writeJSON(complete)
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("failed to hash demo %s: %w", path, err)
	}
	defer file.Close()

	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", fmt.Errorf("failed to hash demo %s: %w", path, err)
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func replaySafe[T any](fallback T, fn func() T) (value T) {
	value = fallback
	defer func() {
		if recover() != nil {
			value = fallback
		}
	}()
	return fn()
}

func replayIntPtr(value int) *int {
	return &value
}

func replayFloatPtr(value float64) *float64 {
	return &value
}

func replayEventCoords(pos r3.Vector) (*float64, *float64, *float64) {
	return replayFloatPtr(pos.X), replayFloatPtr(pos.Y), replayFloatPtr(pos.Z)
}

func replayOptionalCoords(pos replayPosition) (*float64, *float64, *float64) {
	if !pos.ok {
		return nil, nil, nil
	}
	return replayEventCoords(pos.value)
}

func replayPlayerID(player *common.Player) string {
	if player == nil {
		return ""
	}
	steamID := replaySafe(uint64(0), func() uint64 { return player.SteamID64 })
	if steamID != 0 {
		return fmt.Sprintf("%d", steamID)
	}
	userID := replaySafe(0, func() int { return player.UserID })
	entityID := replaySafe(0, func() int { return player.EntityID })
	if userID != 0 {
		return fmt.Sprintf("user:%d", userID)
	}
	if entityID != 0 {
		return fmt.Sprintf("entity:%d", entityID)
	}
	name := replaySafe("", func() string { return player.Name })
	if name != "" {
		return "name:" + name
	}
	return ""
}

func replayTeamSide(team common.Team) string {
	switch team {
	case common.TeamTerrorists:
		return "T"
	case common.TeamCounterTerrorists:
		return "CT"
	case common.TeamSpectators:
		return "SPEC"
	case common.TeamUnassigned:
		return "UNASSIGNED"
	default:
		return ""
	}
}

func replaySide(player *common.Player) string {
	if player == nil {
		return ""
	}
	return replayTeamSide(replaySafe(common.TeamUnassigned, func() common.Team { return player.Team }))
}

func replayIsPlayingPlayer(player *common.Player) bool {
	if player == nil {
		return false
	}
	team := replaySafe(common.TeamUnassigned, func() common.Team { return player.Team })
	return team == common.TeamTerrorists || team == common.TeamCounterTerrorists
}

// replayIsTeamKill reports whether a kill was a team-kill (killer and victim on
// the same playing side). CS2 does not credit team-kills as a frag, so this is
// surfaced on the event so the scoreboard math can exclude them.
func replayIsTeamKill(killer *common.Player, victim *common.Player) bool {
	if killer == nil || victim == nil || killer == victim {
		return false
	}
	killerTeam := replaySafe(common.TeamUnassigned, func() common.Team { return killer.Team })
	victimTeam := replaySafe(common.TeamUnassigned, func() common.Team { return victim.Team })
	if killerTeam != common.TeamTerrorists && killerTeam != common.TeamCounterTerrorists {
		return false
	}
	return killerTeam == victimTeam
}

func replayPlayerPosition(player *common.Player) replayPosition {
	if player == nil {
		return replayPosition{}
	}
	return replaySafe(replayPosition{}, func() replayPosition {
		return replayPosition{value: player.Position(), ok: true}
	})
}

func replayProjectilePosition(projectile *common.GrenadeProjectile) replayPosition {
	if projectile == nil {
		return replayPosition{}
	}
	return replaySafe(replayPosition{}, func() replayPosition {
		return replayPosition{value: projectile.Position(), ok: true}
	})
}

// replayProjectileEntityID returns the in-game entity id of the grenade
// projectile. This matches GrenadeEvent.GrenadeEntityID emitted on detonation
// events, letting the UI link a throw to its smoke/flash/HE/fire detonation
// (projectile.UniqueID() is a random internal id and must NOT be used for this).
func replayProjectileEntityID(projectile *common.GrenadeProjectile) int {
	if projectile == nil {
		return 0
	}
	return replaySafe(0, func() int { return int(projectile.Entity.ID()) })
}

func replayPlayerFrame(player *common.Player) (models.ReplayPlayerFrame, bool) {
	if player == nil || !replayIsPlayingPlayer(player) {
		return models.ReplayPlayerFrame{}, false
	}
	pos := replayPlayerPosition(player)
	if !pos.ok {
		return models.ReplayPlayerFrame{}, false
	}

	weapons := replaySafe([]*common.Equipment(nil), func() []*common.Equipment { return player.Weapons() })
	weaponFrames := make([]models.ReplayWeaponFrame, 0, len(weapons))
	for _, weapon := range weapons {
		if weapon == nil {
			continue
		}
		ammoInMagazine := replaySafe(-1, func() int { return weapon.AmmoInMagazine() })
		isFirearm := replaySafe(false, func() bool {
			switch weapon.Class() {
			case common.EqClassPistols, common.EqClassSMG, common.EqClassHeavy, common.EqClassRifle:
				return true
			}
			return false
		})
		if isFirearm {
			ammoInMagazine = replayAdjustAmmoCount(ammoInMagazine)
		}
		weaponFrames = append(weaponFrames, models.ReplayWeaponFrame{
			Name:           replayEquipmentName(weapon),
			Type:           replayEquipmentTypeName(weapon.Type),
			AmmoInMagazine: ammoInMagazine,
			AmmoReserve:    replaySafe(-1, func() int { return weapon.AmmoReserve() }),
		})
	}
	sort.Slice(weaponFrames, func(i, j int) bool { return weaponFrames[i].Name < weaponFrames[j].Name })

	activeWeapon := replaySafe((*common.Equipment)(nil), func() *common.Equipment { return player.ActiveWeapon() })
	flashMS := int(replaySafe(time.Duration(0), func() time.Duration { return player.FlashDurationTimeRemaining() }).Milliseconds())

	return models.ReplayPlayerFrame{
		ID:             replayPlayerID(player),
		SteamID64:      replaySafe(uint64(0), func() uint64 { return player.SteamID64 }),
		UserID:         replaySafe(0, func() int { return player.UserID }),
		EntityID:       replaySafe(0, func() int { return player.EntityID }),
		Name:           replaySafe("", func() string { return player.Name }),
		Side:           replaySide(player),
		TeamName:       replaySafe("", func() string { return player.TeamState.ClanName() }),
		X:              pos.value.X,
		Y:              pos.value.Y,
		Z:              pos.value.Z,
		Yaw:            float64(replaySafe(float32(0), func() float32 { return player.ViewDirectionX() })),
		Pitch:          float64(replaySafe(float32(0), func() float32 { return player.ViewDirectionY() })),
		Alive:          replaySafe(false, func() bool { return player.IsAlive() }),
		Health:         replaySafe(0, func() int { return player.Health() }),
		Armor:          replaySafe(0, func() int { return player.Armor() }),
		Money:          replaySafe(0, func() int { return player.Money() }),
		EquipmentValue: replaySafe(0, func() int { return player.EquipmentValueCurrent() }),
		Kills:          replaySafe(0, func() int { return player.Kills() }),
		Assists:        replaySafe(0, func() int { return player.Assists() }),
		Deaths:         replaySafe(0, func() int { return player.Deaths() }),
		ActiveWeapon:   replayEquipmentName(activeWeapon),
		Weapons:        weaponFrames,
		HasHelmet:      replaySafe(false, func() bool { return player.HasHelmet() }),
		HasDefuseKit:   replaySafe(false, func() bool { return player.HasDefuseKit() }),
		Scoped:         replaySafe(false, func() bool { return player.IsScoped() }),
		Flashed:        replaySafe(false, func() bool { return player.IsBlinded() }),
		FlashMS:        flashMS,
		Airborne:       replaySafe(false, func() bool { return player.IsAirborne() }),
		Ducking:        replaySafe(false, func() bool { return player.IsDucking() }),
		Walking:        replaySafe(false, func() bool { return player.IsWalking() }),
		Planting:       replaySafe(false, func() bool { return player.IsPlanting }),
		Defusing:       replaySafe(false, func() bool { return player.IsDefusing }),
		Reloading:      replaySafe(false, func() bool { return player.IsReloading }),
		Buttons:        replaySafe(uint64(0), func() uint64 { return player.ButtonsPressedState }),
	}, true
}

func replayProjectileFrame(projectile *common.GrenadeProjectile, tags map[int64][]string) (models.ReplayProjectileFrame, bool) {
	if projectile == nil {
		return models.ReplayProjectileFrame{}, false
	}
	pos := replayProjectilePosition(projectile)
	if !pos.ok {
		return models.ReplayProjectileFrame{}, false
	}
	velocity := replaySafe(r3.Vector{}, func() r3.Vector { return projectile.Velocity() })
	thrower := replaySafe((*common.Player)(nil), func() *common.Player { return projectile.Thrower })
	return models.ReplayProjectileFrame{
		ID:               replaySafe(int64(0), func() int64 { return projectile.UniqueID() }),
		Type:             replayProjectileType(projectile),
		ThrowerSteamID64: replaySafe(uint64(0), func() uint64 { return thrower.SteamID64 }),
		ThrowerID:        replayPlayerID(thrower),
		X:                pos.value.X,
		Y:                pos.value.Y,
		Z:                pos.value.Z,
		VX:               velocity.X,
		VY:               velocity.Y,
		VZ:               velocity.Z,
		Tags:             tags[projectile.UniqueID()],
	}, true
}

func replayInfernoFrame(inferno *common.Inferno) (models.ReplayInfernoFrame, bool) {
	if inferno == nil {
		return models.ReplayInfernoFrame{}, false
	}
	thrower := replaySafe((*common.Player)(nil), func() *common.Player { return inferno.Thrower() })
	fires := replaySafe([]common.Fire(nil), func() []common.Fire { return inferno.Fires().Active().List() })
	fireFrames := make([]models.ReplayFire, 0, len(fires))
	for _, fire := range fires {
		fireFrames = append(fireFrames, models.ReplayFire{
			X:       fire.X,
			Y:       fire.Y,
			Z:       fire.Z,
			Burning: fire.IsBurning,
		})
	}
	hull := replaySafe([]models.ReplayPoint(nil), func() []models.ReplayPoint {
		points := inferno.Fires().Active().ConvexHull2D()
		out := make([]models.ReplayPoint, 0, len(points))
		for _, point := range points {
			out = append(out, models.ReplayPoint{X: point.X, Y: point.Y})
		}
		return out
	})
	return models.ReplayInfernoFrame{
		ID:               replaySafe(int64(0), func() int64 { return inferno.UniqueID() }),
		ThrowerSteamID64: replaySafe(uint64(0), func() uint64 { return thrower.SteamID64 }),
		ThrowerID:        replayPlayerID(thrower),
		Fires:            fireFrames,
		Hull:             hull,
	}, true
}

func replayBombFrame(bomb *common.Bomb, trackedState string, site string) *models.ReplayBombFrame {
	if bomb == nil {
		return nil
	}
	pos := replaySafe(replayPosition{}, func() replayPosition {
		return replayPosition{value: bomb.Position(), ok: true}
	})
	if !pos.ok {
		return nil
	}
	carrier := replaySafe((*common.Player)(nil), func() *common.Player { return bomb.Carrier })
	state := trackedState
	if carrier != nil {
		state = "carried"
	} else if state == "" || state == "carried" || state == "planting" {
		state = "dropped"
	}
	return &models.ReplayBombFrame{
		X:                pos.value.X,
		Y:                pos.value.Y,
		Z:                pos.value.Z,
		CarrierSteamID64: replaySafe(uint64(0), func() uint64 { return carrier.SteamID64 }),
		CarrierID:        replayPlayerID(carrier),
		State:            state,
		Site:             site,
	}
}

func replayEquipmentName(equipment *common.Equipment) string {
	if equipment == nil {
		return ""
	}
	return replaySafe("", func() string { return equipment.String() })
}

func replayEquipmentTypeName(equipmentType common.EquipmentType) string {
	return replaySafe("", func() string { return equipmentType.String() })
}

// replayAdjustAmmoCount corrects the magazine count to match what players see in-game.
// The demoinfocs parser's AmmoInMagazine() returns a value that's 1 less than the actual
// magazine shown to players (e.g., USP shows 11 instead of 12). Adds 1 for loaded firearms
// and clamps non-positive/sentinel values to 0. Reserve and grenade counts are NOT adjusted.
//
// Values above maxMagazineCap are sentinels from the parser (e.g. 0xFFFFFFFF / 4294967295
// representing -1 as an unsigned int for weapons with no real magazine) and must be clamped
// to 0, otherwise +1 turns them into garbage like 4294967296.
const maxMagazineCap = 255

func replayAdjustAmmoCount(ammoInMagazine int) int {
	if ammoInMagazine > 0 && ammoInMagazine <= maxMagazineCap {
		return ammoInMagazine + 1
	}
	return 0
}

func replayProjectileType(projectile *common.GrenadeProjectile) string {
	if projectile == nil {
		return ""
	}
	weapon := replaySafe((*common.Equipment)(nil), func() *common.Equipment { return projectile.WeaponInstance })
	if weapon != nil {
		return replayEquipmentName(weapon)
	}
	return replayGrenadeTypeFromProjectile(projectile)
}

func replayFireGrenadeType(equipment *common.Equipment) string {
	if equipment == nil {
		return ""
	}
	switch equipment.Type {
	case common.EqMolotov:
		return "molotov"
	case common.EqIncendiary:
		return "incendiary grenade"
	default:
		return ""
	}
}

func replayGrenadeTypeFromProjectile(projectile *common.GrenadeProjectile) string {
	if projectile.Entity != nil {
		className := replaySafe("", func() string { return projectile.Entity.ServerClass().Name() })
		if strings.Contains(className, "Smoke") {
			return "Smoke Grenade"
		}
		if strings.Contains(className, "Molotov") || strings.Contains(className, "Incendiary") {
			return "Molotov"
		}
		if strings.Contains(className, "Flash") {
			return "Flashbang"
		}
		if strings.Contains(className, "HE") || strings.Contains(className, "Frag") {
			return "HE Grenade"
		}
		if strings.Contains(className, "Decoy") {
			return "Decoy Grenade"
		}
	}
	return "Unknown"
}

func findThrowReleaseSnapshot(attackHistory []uint64, posHistory []PositionSnapshot, throwTick int) *PositionSnapshot {
	attackButton := uint64(common.ButtonAttack) | uint64(common.ButtonAttack2)
	lastPressedIdx := -1
	checkStart := len(attackHistory) - 20
	if checkStart < 0 {
		checkStart = 0
	}
	for i := len(attackHistory) - 1; i >= checkStart; i-- {
		if (attackHistory[i] & attackButton) != 0 {
			lastPressedIdx = i
			break
		}
	}
	if lastPressedIdx < 0 {
		return findSnapshotAtOrBeforeTick(posHistory, throwTick-2)
	}
	releaseTick := lastPressedIdx + 1
	return findSnapshotAtOrBeforeTick(posHistory, releaseTick)
}

func replayRoundEndReason(reason events.RoundEndReason) string {
	switch reason {
	case events.RoundEndReasonTargetBombed:
		return "target_bombed"
	case events.RoundEndReasonBombDefused:
		return "bomb_defused"
	case events.RoundEndReasonCTWin:
		return "ct_win"
	case events.RoundEndReasonTerroristsWin:
		return "t_win"
	case events.RoundEndReasonDraw:
		return "draw"
	case events.RoundEndReasonTargetSaved:
		return "target_saved"
	case events.RoundEndReasonTerroristsSurrender:
		return "t_surrender"
	case events.RoundEndReasonCTSurrender:
		return "ct_surrender"
	case events.RoundEndReasonTerroristsPlanted:
		return "t_planted"
	default:
		return fmt.Sprintf("reason_%d", reason)
	}
}

func replayBombsite(site events.Bombsite) string {
	switch site {
	case events.BombsiteA:
		return "A"
	case events.BombsiteB:
		return "B"
	default:
		return ""
	}
}

func replayKillMessage(e events.Kill) string {
	killer := replaySafe("", func() string { return e.Killer.Name })
	victim := replaySafe("", func() string { return e.Victim.Name })
	weapon := replayEquipmentName(e.Weapon)
	if killer == "" {
		killer = "World"
	}
	if victim == "" {
		victim = "player"
	}
	if weapon == "" {
		return killer + " killed " + victim
	}
	return killer + " killed " + victim + " with " + weapon
}

func replayDamageMessage(e events.PlayerHurt) string {
	attacker := replaySafe("", func() string { return e.Attacker.Name })
	victim := replaySafe("", func() string { return e.Player.Name })
	if attacker == "" {
		attacker = "World"
	}
	if victim == "" {
		victim = "player"
	}
	return fmt.Sprintf("%s damaged %s for %d", attacker, victim, e.HealthDamageTaken)
}
