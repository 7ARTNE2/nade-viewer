package parser

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/golang/geo/r3"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/sendtables"
	"nadesoulpars/pkg/models"
	"nadesoulpars/pkg/utils"
)

const replayFormat = "nadeviewer_replay"
const replayVersion = 1

type ReplayOptions struct{ SampleFPS float64 }
type replayPosition struct {
	value r3.Vector
	ok    bool
}

// Both public entry points consume this single collector.
func ParseReplayFile(path string, options ReplayOptions) (*models.ReplayFile, error) {
	result := &models.ReplayFile{Format: replayFormat, Version: replayVersion}
	err := collectReplay(path, options, func(line models.ReplayStreamLine) error {
		switch line.Type {
		case "round":
			result.Rounds = append(result.Rounds, *line.Round)
			result.Frames = append(result.Frames, line.Frames...)
			result.Events = append(result.Events, line.Events...)
		case "grenade":
			result.Grenades = append(result.Grenades, *line.Grenade)
			result.Events = append(result.Events, line.Events...)
		case "complete":
			result.Players = line.Players
			result.Metadata = models.ReplayMetadata{SourcePath: path, DemoFilename: line.DemoFilename,
				FileSHA256: line.FileSHA256, Map: line.Map, TickRate: line.TickRate, SampleFPS: line.SampleFPS,
				StartTick: line.StartTick, EndTick: line.EndTick, TeamT: line.TeamT, TeamCT: line.TeamCT,
				ParsedAt: line.ParsedAt, FrameCount: line.FrameCount, EventCount: line.EventCount,
				RoundCount: line.RoundCount, Incomplete: line.Incomplete}
		}
		return nil
	})
	sort.SliceStable(result.Events, func(i, j int) bool { return result.Events[i].Tick < result.Events[j].Tick })
	return result, err
}

func ParseReplayFileStreaming(path string, options ReplayOptions, out io.Writer) error {
	// Replay frames are large and numerous. Buffer the NDJSON stream so the
	// parser does not perform a pipe write for every frame/round record.
	buffered := bufio.NewWriterSize(out, 1<<20)
	encoder := json.NewEncoder(buffered)
	err := collectReplay(path, options, func(line models.ReplayStreamLine) error {
		return encoder.Encode(line)
	})
	if flushErr := buffered.Flush(); err == nil {
		err = flushErr
	}
	return err
}

func collectReplay(path string, options ReplayOptions, emit func(models.ReplayStreamLine) error) error {
	if options.SampleFPS <= 0 {
		options.SampleFPS = 16
	}
	if math.IsNaN(options.SampleFPS) || math.IsInf(options.SampleFPS, 0) || options.SampleFPS < 1 || options.SampleFPS > 64 {
		return fmt.Errorf("sample FPS must be between 1 and 64")
	}
	hash, err := sha256File(path)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	p := demoinfocs.NewParser(file)
	defer p.Close()
	nades := NewDemoParser(path)
	airtime := registerAirtimeTracker(p)
	var writeErr error
	write := func(line models.ReplayStreamLine) {
		if writeErr == nil {
			writeErr = emit(line)
		}
		if writeErr != nil {
			p.Cancel()
		}
	}
	tick := func() int { return p.GameState().IngameTick() }
	rate := func() float64 {
		r := p.TickRate()
		if r <= 0 {
			return 64
		}
		return r
	}
	current := models.ReplayRound{Number: 0, StartTick: 0}
	frames := []models.ReplayFrame{}
	eventList := []models.ReplayEvent{}
	roster := map[string]models.ReplayPlayerRoster{}
	type throwRef struct {
		round int
		tick  int
	}
	throws := map[int64]throwRef{}
	accepted := map[int64]bool{}
	lastTick := -1
	nextSampleTick := 0.0
	startTick, endTick, frameCount, eventCount, roundCount := -1, 0, 0, 0, 0
	bombState, bombSite := "unknown", ""
	var plantedBomb sendtables.Entity
	var plantedBombPos replayPosition
	var bombTimerData map[string]interface{}
	type flashAssistEntry struct {
		attackerID string
		tick       int
	}
	flashAssistByVictim := map[string]flashAssistEntry{}
	p.RegisterEventHandler(func(events.DataTablesParsed) {
		if class := p.ServerClasses().FindByName("CPlantedC4"); class != nil {
			class.OnEntityCreated(func(entity sendtables.Entity) {
				plantedBomb = entity
				entity.OnDestroy(func() {
					if plantedBomb == entity {
						plantedBomb = nil
					}
				})
			})
		}
	})
	metadataWritten := false
	parsedAt := time.Now().UTC().Format(time.RFC3339)
	event := func(kind, message string, actor, target *common.Player, pos replayPosition, data map[string]interface{}) {
		x, y, z := replayOptionalCoords(pos)
		eventList = append(eventList, models.ReplayEvent{Tick: tick(), RoundNumber: current.Number,
			Type: kind, Message: message, PlayerID: replayPlayerID(actor), TargetID: replayPlayerID(target),
			PlayerSteamID64: replaySafe(uint64(0), func() uint64 { return actor.SteamID64 }),
			TargetSteamID64: replaySafe(uint64(0), func() uint64 { return target.SteamID64 }),
			Side:            replaySide(actor), X: x, Y: y, Z: z, Data: data})
	}
	flush := func() {
		if len(frames) == 0 && len(eventList) == 0 {
			return
		}
		frameCount += len(frames)
		eventCount += len(eventList)
		roundCount++
		copyRound := current
		if copyRound.EndTick == nil {
			copyRound.EndTick = replayIntPtr(endTick)
		}
		write(models.ReplayStreamLine{Type: "round", RoundNumber: current.Number, Round: &copyRound, Frames: frames, Events: eventList})
		frames = []models.ReplayFrame{}
		eventList = []models.ReplayEvent{}
	}
	finish := nades.registerGrenades(p, airtime,
		func(projectile *common.GrenadeProjectile, release int) {
			id := projectile.UniqueID()
			accepted[id] = true
			throws[id] = throwRef{current.Number, release}
			event("grenade_throw", utils.GetDjangoGrenadeType(projectile.WeaponInstance.Type.String()),
				projectile.Thrower, nil, replayProjectilePosition(projectile),
				map[string]interface{}{"projectile_id": fmt.Sprint(id), "grenade_entity_id": replayProjectileEntityID(projectile)})
		},
		func(g *models.ParsedGrenade, id int64, release int) {
			ref := throws[id]
			grenade := models.ReplayGrenade{ID: fmt.Sprint(id), RoundNumber: ref.round, ReleaseTick: release,
				Data: ConvertToGrenadeDataWithOptions(g, DefaultOutputOptions())}
			destroy := models.ReplayEvent{Tick: tick(), RoundNumber: ref.round, Type: "grenade_destroy",
				PlayerID: fmt.Sprint(g.ThrowerSteamID64), Data: map[string]interface{}{"projectile_id": fmt.Sprint(id), "airtime": g.Airtime}}
			write(models.ReplayStreamLine{Type: "grenade", RoundNumber: ref.round, Grenade: &grenade, Events: []models.ReplayEvent{destroy}})
			eventCount++
			delete(throws, id)
			delete(accepted, id)
		}, true)
	p.RegisterEventHandler(func(e events.RoundStart) {
		flush()
		current = models.ReplayRound{Number: current.Number + 1, StartTick: tick()}
		current.DurationSeconds = nades.roundDurationSeconds
		current.ScoreT = replaySafe(0, func() int { return p.GameState().TeamTerrorists().Score() })
		current.ScoreCT = replaySafe(0, func() int { return p.GameState().TeamCounterTerrorists().Score() })
		bombState, bombSite = "unknown", ""
		plantedBombPos = replayPosition{}
		bombTimerData = nil
		event("round_start", "", nil, nil, replayPosition{}, nil)
	})
	p.RegisterEventHandler(func(e events.RoundFreezetimeEnd) {
		current.FreezeEndTick = replayIntPtr(tick())
		current.DurationSeconds = nades.roundDurationSeconds
		event("freezetime_end", "", nil, nil, replayPosition{}, nil)
	})
	p.RegisterEventHandler(func(e events.RoundEnd) {
		current.EndTick = replayIntPtr(tick())
		current.WinnerSide = replayTeamSide(e.Winner)
		current.Reason = replayRoundEndReason(e.Reason)
		event("round_end", e.Message, nil, nil, replayPosition{}, nil)
	})
	p.RegisterEventHandler(func(e events.Kill) {
		data := map[string]interface{}{
			"weapon":             replayEquipmentName(e.Weapon),
			"assister_id":        replayPlayerID(e.Assister),
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
			if entry, ok := flashAssistByVictim[replayPlayerID(e.Victim)]; ok {
				data["flash_assister_id"] = entry.attackerID
				data["flash_assist_tick"] = entry.tick
			}
		}
		event("kill", replayKillMessage(e), e.Killer, e.Victim, replayPlayerPosition(e.Victim),
			data)
		delete(flashAssistByVictim, replayPlayerID(e.Victim))
	})
	p.RegisterEventHandler(func(e events.PlayerHurt) {
		attackerWeapon := replaySafe((*common.Equipment)(nil), func() *common.Equipment {
			if e.Attacker == nil {
				return nil
			}
			return e.Attacker.ActiveWeapon()
		})
		event("damage", replayDamageMessage(e), e.Attacker, e.Player, replayPlayerPosition(e.Player),
			map[string]interface{}{
				"damage": e.HealthDamageTaken,
				"weapon": replayEquipmentName(attackerWeapon),
			})
	})
	p.RegisterEventHandler(func(e events.WeaponFire) {
		shooter := e.Shooter
		if shooter == nil {
			return
		}
		activeWeapon := replaySafe((*common.Equipment)(nil), func() *common.Equipment { return shooter.ActiveWeapon() })
		data := map[string]interface{}{
			"weapon": replayEquipmentName(activeWeapon),
			"yaw":    float64(replaySafe(float32(0), func() float32 { return shooter.ViewDirectionX() })),
		}
		event("weapon_fire", "Weapon fired", shooter, nil, replayPlayerPosition(shooter), data)
	})
	p.RegisterEventHandler(func(e events.PlayerFlashed) {
		victimID := replayPlayerID(e.Player)
		attackerID := replayPlayerID(e.Attacker)
		event("player_flashed", "Player flashed", e.Attacker, e.Player, replayPlayerPosition(e.Player),
			map[string]interface{}{"flash_ms": int(replaySafe(time.Duration(0), func() time.Duration { return e.FlashDuration() }).Milliseconds())})
		if victimID != "" && attackerID != "" {
			flashAssistByVictim[victimID] = flashAssistEntry{attackerID: attackerID, tick: tick()}
		}
	})
	grenadeEvent := func(kind string, e events.GrenadeEvent) {
		event(kind, "", e.Thrower, nil, replayPosition{e.Position, true},
			map[string]interface{}{"grenade_entity_id": e.GrenadeEntityID})
	}
	p.RegisterEventHandler(func(e events.SmokeStart) { grenadeEvent("smoke_start", e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.SmokeExpired) { grenadeEvent("smoke_expired", e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.DecoyStart) { grenadeEvent("decoy_start", e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.DecoyExpired) { grenadeEvent("decoy_expired", e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.HeExplode) { grenadeEvent("he_explode", e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.FlashExplode) { grenadeEvent("flash_explode", e.GrenadeEvent) })
	p.RegisterEventHandler(func(e events.BombPlantBegin) {
		bombState = "planting"
		bombSite = replayBombsite(e.Site)
		event("bomb_plant_begin", "", e.Player, nil, replayPlayerPosition(e.Player), nil)
	})
	p.RegisterEventHandler(func(e events.BombPlantAborted) { bombState = "carried" })
	p.RegisterEventHandler(func(e events.BombPlanted) {
		bombState = "planted"
		bombSite = replayBombsite(e.Site)
		plantedBombPos = replayPlayerPosition(e.Player)
		data := map[string]interface{}{}
		bombTimerData = data
		if rules := p.GameState().Rules(); rules != nil {
			if duration, err := rules.BombTime(); err == nil && duration > 0 {
				data["duration_seconds"] = duration.Seconds()
			}
		}
		event("bomb_planted", bombSite, e.Player, nil, replayPlayerPosition(e.Player), data)
	})
	p.RegisterEventHandler(func(e events.BombDefuseStart) {
		event("bomb_defuse_start", "", e.Player, nil, replayPlayerPosition(e.Player), nil)
	})
	p.RegisterEventHandler(func(e events.BombDefused) {
		bombState = "defused"
		event("bomb_defused", "", e.Player, nil, replayPlayerPosition(e.Player), nil)
	})
	p.RegisterEventHandler(func(e events.BombExplode) {
		bombState = "exploded"
		event("bomb_exploded", "", e.Player, nil, plantedBombPos, nil)
	})
	p.RegisterEventHandler(func(e events.BombDropped) { bombState = "dropped" })
	p.RegisterEventHandler(func(e events.BombPickup) { bombState = "carried" })
	p.RegisterEventHandler(func(e events.FrameDone) {
		t := tick()
		if plantedBomb != nil && bombTimerData != nil {
			if value, ok := plantedBomb.PropertyValue("m_flTimerLength"); ok {
				if duration := float64(value.Float()); duration > 0 {
					bombTimerData["duration_seconds"] = duration
				}
			}
		}
		if t < 0 {
			return
		}
		if startTick < 0 {
			startTick = t
		}
		endTick = t
		if !metadataWritten {
			write(models.ReplayStreamLine{Type: "metadata", Format: replayFormat, Version: replayVersion, FileSHA256: hash,
				Map: nades.mapName, DemoFilename: nades.fileName, SourcePath: path, TickRate: rate(), SampleFPS: options.SampleFPS, ParsedAt: parsedAt})
			metadataWritten = true
		}
		interval := rate() / options.SampleFPS
		if interval == math.Trunc(interval) && t%int(interval) != 0 {
			return
		}
		if lastTick >= 0 && float64(t) < nextSampleTick {
			return
		}
		if lastTick < 0 || float64(t-lastTick) > rate() {
			nextSampleTick = float64(t) + interval
		} else {
			for nextSampleTick <= float64(t) {
				nextSampleTick += interval
			}
		}
		lastTick = t
		f := models.ReplayFrame{Tick: t, RoundNumber: current.Number, Players: []models.ReplayPlayerFrame{}, Projectiles: []models.ReplayProjectileFrame{}, Infernos: []models.ReplayInfernoFrame{}}
		for _, player := range p.GameState().Participants().All() {
			state, ok := replayPlayerFrame(player)
			if !ok {
				continue
			}
			f.Players = append(f.Players, state)
			roster[state.ID] = models.ReplayPlayerRoster{ID: state.ID, SteamID64: state.SteamID64, Name: state.Name, Side: state.Side, TeamName: state.TeamName, UserID: state.UserID, EntityID: state.EntityID}
		}
		sort.Slice(f.Players, func(i, j int) bool { return f.Players[i].ID < f.Players[j].ID })
		for _, projectile := range p.GameState().GrenadeProjectiles() {
			if !accepted[projectile.UniqueID()] {
				continue
			}
			if state, ok := replayProjectileFrame(projectile, nil); ok {
				f.Projectiles = append(f.Projectiles, state)
			}
		}
		sort.Slice(f.Projectiles, func(i, j int) bool { return f.Projectiles[i].ID < f.Projectiles[j].ID })
		for _, inferno := range p.GameState().Infernos() {
			if state, ok := replayInfernoFrame(inferno); ok {
				f.Infernos = append(f.Infernos, state)
			}
		}
		f.Bomb = replayBombFrame(p.GameState().Bomb(), bombState, bombSite)
		frames = append(frames, f)
	})
	parseErr := p.ParseToEnd()
	if writeErr != nil {
		return writeErr
	}
	incomplete := errors.Is(parseErr, demoinfocs.ErrUnexpectedEndOfDemo)
	if parseErr != nil && !incomplete {
		return fmt.Errorf("replay parse: %w", parseErr)
	}
	finish()
	if current.EndTick == nil {
		current.EndTick = replayIntPtr(endTick)
	}
	flush()
	players := make([]models.ReplayPlayerRoster, 0, len(roster))
	for _, player := range roster {
		players = append(players, player)
	}
	sort.Slice(players, func(i, j int) bool { return players[i].ID < players[j].ID })
	write(models.ReplayStreamLine{Type: "complete", Format: replayFormat, Version: replayVersion, FileSHA256: hash,
		Map: nades.mapName, SourcePath: path, DemoFilename: nades.fileName, TickRate: rate(), SampleFPS: options.SampleFPS,
		StartTick: startTick, EndTick: endTick, ParsedAt: parsedAt, FrameCount: frameCount, EventCount: eventCount, RoundCount: roundCount,
		TeamT:   replaySafe("", func() string { return p.GameState().TeamTerrorists().ClanName() }),
		TeamCT:  replaySafe("", func() string { return p.GameState().TeamCounterTerrorists().ClanName() }),
		Players: players, Incomplete: incomplete})
	return writeErr
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
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
	activeFires := replaySafe(common.Fires{}, func() common.Fires { return inferno.Fires().Active() })
	fires := replaySafe([]common.Fire(nil), func() []common.Fire { return activeFires.List() })
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
		points := activeFires.ConvexHull2D()
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
