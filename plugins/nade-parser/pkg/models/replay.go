package models

import (
	"encoding/json"
	"strconv"
)

type ReplayFile struct {
	Format   string               `json:"format"`
	Version  int                  `json:"version"`
	Metadata ReplayMetadata       `json:"metadata"`
	Players  []ReplayPlayerRoster `json:"players"`
	Rounds   []ReplayRound        `json:"rounds"`
	Frames   []ReplayFrame        `json:"frames"`
	Events   []ReplayEvent        `json:"events"`
	Grenades []ReplayGrenade      `json:"grenades"`
}

type ReplayMetadata struct {
	SourcePath   string  `json:"source_path"`
	DemoFilename string  `json:"demo_filename"`
	FileSHA256   string  `json:"file_sha256"`
	Map          string  `json:"map"`
	TickRate     float64 `json:"tickrate"`
	SampleFPS    float64 `json:"sample_fps"`
	StartTick    int     `json:"start_tick"`
	EndTick      int     `json:"end_tick"`
	TeamT        string  `json:"team_t"`
	TeamCT       string  `json:"team_ct"`
	ParsedAt     string  `json:"parsed_at"`
	FrameCount   int     `json:"frame_count"`
	EventCount   int     `json:"event_count"`
	RoundCount   int     `json:"round_count"`
	Incomplete   bool    `json:"incomplete"`
}

type ReplayPlayerRoster struct {
	ID        string `json:"id"`
	SteamID64 uint64 `json:"steamid64,string"`
	UserID    int    `json:"user_id"`
	EntityID  int    `json:"entity_id"`
	Name      string `json:"name"`
	Side      string `json:"side"`
	TeamName  string `json:"team_name"`
	IsBot     bool   `json:"is_bot"`
}

type ReplayRound struct {
	Number        int    `json:"number"`
	StartTick     int    `json:"start_tick"`
	FreezeEndTick *int   `json:"freeze_end_tick"`
	EndTick       *int   `json:"end_tick"`
	WinnerSide    string `json:"winner_side"`
	Reason        string `json:"reason"`
	ScoreT        int    `json:"score_t"`
	ScoreCT       int    `json:"score_ct"`
}

type ReplayFrame struct {
	Tick        int                     `json:"tick"`
	RoundNumber int                     `json:"round_number"`
	Players     []ReplayPlayerFrame     `json:"players"`
	Projectiles []ReplayProjectileFrame `json:"projectiles"`
	Infernos    []ReplayInfernoFrame    `json:"infernos"`
	Bomb        *ReplayBombFrame        `json:"bomb"`
}

type ReplayPlayerFrame struct {
	ID             string              `json:"id"`
	SteamID64      uint64              `json:"steamid64,string"`
	UserID         int                 `json:"user_id"`
	EntityID       int                 `json:"entity_id"`
	Name           string              `json:"name"`
	Side           string              `json:"side"`
	TeamName       string              `json:"team_name"`
	X              float64             `json:"x"`
	Y              float64             `json:"y"`
	Z              float64             `json:"z"`
	Yaw            float64             `json:"yaw"`
	Pitch          float64             `json:"pitch"`
	Alive          bool                `json:"alive"`
	Health         int                 `json:"health"`
	Armor          int                 `json:"armor"`
	Money          int                 `json:"money"`
	EquipmentValue int                 `json:"equipment_value"`
	Kills          int                 `json:"kills"`
	Assists        int                 `json:"assists"`
	Deaths         int                 `json:"deaths"`
	ActiveWeapon   string              `json:"active_weapon"`
	Weapons        []ReplayWeaponFrame `json:"weapons"`
	HasHelmet      bool                `json:"has_helmet"`
	HasDefuseKit   bool                `json:"has_defuse_kit"`
	Scoped         bool                `json:"scoped"`
	Flashed        bool                `json:"flashed"`
	FlashMS        int                 `json:"flash_ms"`
	Airborne       bool                `json:"airborne"`
	Ducking        bool                `json:"ducking"`
	Walking        bool                `json:"walking"`
	Planting       bool                `json:"planting"`
	Defusing       bool                `json:"defusing"`
	Reloading      bool                `json:"reloading"`
	Buttons        uint64              `json:"buttons,string"`
}

type ReplayWeaponFrame struct {
	Name           string `json:"name"`
	Type           string `json:"type"`
	AmmoInMagazine int    `json:"ammo_in_magazine"`
	AmmoReserve    int    `json:"ammo_reserve"`
}

type ReplayProjectileFrame struct {
	ID               int64    `json:"id,string"`
	Type             string   `json:"type"`
	ThrowerSteamID64 uint64   `json:"thrower_steamid64,string"`
	ThrowerID        string   `json:"thrower_id"`
	X                float64  `json:"x"`
	Y                float64  `json:"y"`
	Z                float64  `json:"z"`
	VX               float64  `json:"vx"`
	VY               float64  `json:"vy"`
	VZ               float64  `json:"vz"`
	Tags             []string `json:"tags,omitempty"`
}

type ReplayInfernoFrame struct {
	ID               int64         `json:"id,string"`
	ThrowerSteamID64 uint64        `json:"thrower_steamid64,string"`
	ThrowerID        string        `json:"thrower_id"`
	Fires            []ReplayFire  `json:"fires"`
	Hull             []ReplayPoint `json:"hull"`
}

type ReplayFire struct {
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Z       float64 `json:"z"`
	Burning bool    `json:"burning"`
}

type ReplayPoint struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z,omitempty"`
}

type ReplayBombFrame struct {
	X                float64 `json:"x"`
	Y                float64 `json:"y"`
	Z                float64 `json:"z"`
	CarrierSteamID64 uint64  `json:"carrier_steamid64,string"`
	CarrierID        string  `json:"carrier_id"`
	State            string  `json:"state"`
	Site             string  `json:"site"`
}

type ReplayEvent struct {
	Tick            int                    `json:"tick"`
	RoundNumber     int                    `json:"round_number"`
	Type            string                 `json:"type"`
	Message         string                 `json:"message"`
	Side            string                 `json:"side"`
	PlayerSteamID64 uint64                 `json:"player_steamid64,omitempty,string"`
	PlayerID        string                 `json:"player_id,omitempty"`
	TargetSteamID64 uint64                 `json:"target_steamid64,omitempty,string"`
	TargetID        string                 `json:"target_id,omitempty"`
	X               *float64               `json:"x"`
	Y               *float64               `json:"y"`
	Z               *float64               `json:"z"`
	Data            map[string]interface{} `json:"data,omitempty"`
}

type ReplayStreamLine struct {
	Type         string               `json:"type"`
	SourcePath   string               `json:"source_path,omitempty"`
	DemoFilename string               `json:"demo_filename,omitempty"`
	FileSHA256   string               `json:"file_sha256,omitempty"`
	Map          string               `json:"map,omitempty"`
	TickRate     float64              `json:"tickrate,omitempty"`
	SampleFPS    float64              `json:"sample_fps,omitempty"`
	StartTick    int                  `json:"start_tick,omitempty"`
	EndTick      int                  `json:"end_tick,omitempty"`
	TeamT        string               `json:"team_t,omitempty"`
	TeamCT       string               `json:"team_ct,omitempty"`
	ParsedAt     string               `json:"parsed_at,omitempty"`
	FrameCount   int                  `json:"frame_count,omitempty"`
	EventCount   int                  `json:"event_count,omitempty"`
	RoundCount   int                  `json:"round_count,omitempty"`
	RoundNumber  int                  `json:"round_number"`
	Round        *ReplayRound         `json:"round,omitempty"`
	Frames       []ReplayFrame        `json:"frames"`
	Events       []ReplayEvent        `json:"events"`
	Players      []ReplayPlayerRoster `json:"players,omitempty"`
	Format       string               `json:"format,omitempty"`
	Version      int                  `json:"version,omitempty"`
	Incomplete   bool                 `json:"incomplete,omitempty"`
	Grenade      *ReplayGrenade       `json:"grenade,omitempty"`
}

type ReplayGrenade struct {
	ID          string      `json:"id"`
	RoundNumber int         `json:"round_number"`
	ReleaseTick int         `json:"release_tick"`
	Data        GrenadeData `json:"data"`
}

// Canonical exports keep their existing numeric contract; replay IDs are lossless in JS.
func (g ReplayGrenade) MarshalJSON() ([]byte, error) {
	type replayData struct {
		GrenadeData
		SteamID string `json:"thrower_steamid64"`
		Events  []struct {
			UsageEvent
			SteamID string `json:"thrower_steamid64"`
		} `json:"usage_events,omitempty"`
	}
	data := replayData{GrenadeData: g.Data, SteamID: strconv.FormatInt(g.Data.ThrowerSteamID64, 10)}
	for _, event := range g.Data.UsageEvents {
		data.Events = append(data.Events, struct {
			UsageEvent
			SteamID string `json:"thrower_steamid64"`
		}{event, strconv.FormatInt(event.ThrowerSteamID64, 10)})
	}
	return json.Marshal(struct {
		ID    string     `json:"id"`
		Round int        `json:"round_number"`
		Tick  int        `json:"release_tick"`
		Data  replayData `json:"data"`
	}{g.ID, g.RoundNumber, g.ReleaseTick, data})
}

func (g *ReplayGrenade) UnmarshalJSON(raw []byte) error {
	var wire struct {
		ID    string          `json:"id"`
		Round int             `json:"round_number"`
		Tick  int             `json:"release_tick"`
		Data  json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return err
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal(wire.Data, &data); err != nil {
		return err
	}
	normalize := func(fields map[string]json.RawMessage) error {
		if id := fields["thrower_steamid64"]; len(id) > 0 && id[0] == '"' {
			var value string
			if err := json.Unmarshal(id, &value); err != nil {
				return err
			}
			if _, err := strconv.ParseInt(value, 10, 64); err != nil {
				return err
			}
			fields["thrower_steamid64"] = json.RawMessage(value)
		}
		return nil
	}
	if err := normalize(data); err != nil {
		return err
	}
	if events, ok := data["usage_events"]; ok {
		var items []map[string]json.RawMessage
		if err := json.Unmarshal(events, &items); err != nil {
			return err
		}
		for _, item := range items {
			if err := normalize(item); err != nil {
				return err
			}
		}
		data["usage_events"], _ = json.Marshal(items)
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(encoded, &g.Data); err != nil {
		return err
	}
	g.ID, g.RoundNumber, g.ReleaseTick = wire.ID, wire.Round, wire.Tick
	return nil
}
