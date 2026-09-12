package models

type ReplayFile struct {
	Format   string               `json:"format"`
	Version  int                  `json:"version"`
	Metadata ReplayMetadata       `json:"metadata"`
	Players  []ReplayPlayerRoster `json:"players"`
	Rounds   []ReplayRound        `json:"rounds"`
	Frames   []ReplayFrame        `json:"frames"`
	Events   []ReplayEvent        `json:"events"`
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
}

type ReplayPlayerRoster struct {
	ID        string `json:"id"`
	SteamID64 uint64 `json:"steamid64"`
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
	SteamID64      uint64              `json:"steamid64"`
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
	Buttons        uint64              `json:"buttons"`
}

type ReplayWeaponFrame struct {
	Name           string `json:"name"`
	Type           string `json:"type"`
	AmmoInMagazine int    `json:"ammo_in_magazine"`
	AmmoReserve    int    `json:"ammo_reserve"`
}

type ReplayProjectileFrame struct {
	ID               int64    `json:"id"`
	Type             string   `json:"type"`
	ThrowerSteamID64 uint64   `json:"thrower_steamid64"`
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
	ID               int64         `json:"id"`
	ThrowerSteamID64 uint64        `json:"thrower_steamid64"`
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
	CarrierSteamID64 uint64  `json:"carrier_steamid64"`
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
	PlayerSteamID64 uint64                 `json:"player_steamid64,omitempty"`
	PlayerID        string                 `json:"player_id,omitempty"`
	TargetSteamID64 uint64                 `json:"target_steamid64,omitempty"`
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
	RoundNumber  int                  `json:"round_number,omitempty"`
	Round        *ReplayRound         `json:"round,omitempty"`
	Frames       []ReplayFrame        `json:"frames,omitempty"`
	Events       []ReplayEvent        `json:"events,omitempty"`
	Players      []ReplayPlayerRoster `json:"players,omitempty"`
}
