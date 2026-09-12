package models

// GrenadeData представляет данные о гранате для отправки в Django API
// Соответствует полям в grenades/serializers.py
type GrenadeData struct {
	Map                string   `json:"map" msgpack:"map"`
	Side               string   `json:"side" msgpack:"side"`
	GrenadeType        string   `json:"grenade_type" msgpack:"grenade_type"`
	ThrowKeys          string   `json:"throw_keys,omitempty" msgpack:"throw_keys,omitempty"`
	UsageCount         int      `json:"usage_count,omitempty" msgpack:"usage_count,omitempty"`
	UsageThrowers      []string `json:"usage_throwers,omitempty" msgpack:"usage_throwers,omitempty"`
	Coordinates        string   `json:"coordinates,omitempty" msgpack:"coordinates,omitempty"`
	Author             string   `json:"author,omitempty" msgpack:"author,omitempty"`
	DemoFilename       string   `json:"demo_filename,omitempty" msgpack:"demo_filename,omitempty"`
	ThrowTick          int      `json:"throw_tick,omitempty" msgpack:"throw_tick,omitempty"`
	LineupTick         *int     `json:"lineup_tick,omitempty" msgpack:"lineup_tick,omitempty"`
	Tickrate           float64  `json:"tickrate,omitempty" msgpack:"tickrate,omitempty"`
	RoundTimeSeconds   *float64 `json:"round_time_seconds,omitempty" msgpack:"round_time_seconds,omitempty"`
	ThrowerSteamID64   int64    `json:"thrower_steamid64,omitempty" msgpack:"thrower_steamid64,omitempty"`
	ThrowerAccountID   int64    `json:"thrower_accountid,omitempty" msgpack:"thrower_accountid,omitempty"`
	ThrowerEntityID    *int     `json:"thrower_entity_id,omitempty" msgpack:"thrower_entity_id,omitempty"`
	ProjectileEntityID *int     `json:"projectile_entity_id,omitempty" msgpack:"projectile_entity_id,omitempty"`

	// Игровые координаты начала полёта
	StartPosX float64 `json:"start_pos_x,omitempty" msgpack:"start_pos_x,omitempty"`
	StartPosY float64 `json:"start_pos_y,omitempty" msgpack:"start_pos_y,omitempty"`
	StartPosZ float64 `json:"start_pos_z,omitempty" msgpack:"start_pos_z,omitempty"`

	// Игровые координаты взрыва/приземления
	ExplodePosX float64 `json:"explode_pos_x,omitempty" msgpack:"explode_pos_x,omitempty"`
	ExplodePosY float64 `json:"explode_pos_y,omitempty" msgpack:"explode_pos_y,omitempty"`
	ExplodePosZ float64 `json:"explode_pos_z,omitempty" msgpack:"explode_pos_z,omitempty"`

	// Траектория полёта (список точек [x, y, z])
	Trajectory           [][]float64 `json:"trajectory,omitempty" msgpack:"trajectory,omitempty"`
	TrajectoryTicks      []int       `json:"trajectory_ticks,omitempty" msgpack:"trajectory_ticks,omitempty"`
	TrajectoryDense      [][]float64 `json:"trajectory_dense,omitempty" msgpack:"trajectory_dense,omitempty"`
	TrajectoryDenseTicks []int       `json:"trajectory_dense_ticks,omitempty" msgpack:"trajectory_dense_ticks,omitempty"`

	// Дополнительные данные
	Thrower     string  `json:"thrower,omitempty" msgpack:"thrower,omitempty"`
	ThrowerTeam string  `json:"thrower_team,omitempty" msgpack:"thrower_team,omitempty"`
	Airtime     float64 `json:"airtime,omitempty" msgpack:"airtime,omitempty"`
	Team1       string  `json:"team1,omitempty" msgpack:"team1,omitempty"`
	Team2       string  `json:"team2,omitempty" msgpack:"team2,omitempty"`
	IsManual    bool    `json:"is_manual" msgpack:"is_manual"`
}

// TrajectoryPoint представляет одну точку траектории
type TrajectoryPoint struct {
	X float64
	Y float64
	Z float64
}

// PlayerState состояние игрока в момент броска
type PlayerState struct {
	Position TrajectoryPoint
	Pitch    float64  // Угол взгляда вверх/вниз
	Yaw      float64  // Угол взгляда влево/вправо
	Buttons  []string // Нажатые кнопки
}

// NadeTrajectory хранит информацию о траектории гранаты
type NadeTrajectory struct {
	UniqueID             int64
	WeaponType           string
	ThrowerSteamID       int64
	ThrowerName          string
	ThrowerTeam          string
	ThrowerEntityID      *int
	Team                 string
	Trajectory           []TrajectoryPoint
	TrajectoryTicks      []int
	TrajectoryDense      []TrajectoryPoint
	TrajectoryDenseTicks []int
	StartTick            int
	LineupTick           *int
	EndTick              int
	RoundTimeSeconds     *float64

	// Состояние игрока в момент броска
	PlayerState *PlayerState

	// Airtime override (из FrameDone tracker)
	AirtimeOverride float64

	// Tags for problematic grenades (e.g. "fail")
	Tags []string
}

// ParsedGrenade содержит все данные о спарсенной гранате
type ParsedGrenade struct {
	MapName          string
	Side             string
	GrenadeType      string
	DemoFilename     string
	ThrowTick        int
	LineupTick       *int
	Tickrate         float64
	RoundTimeSeconds *float64
	ThrowerSteamID64 int64
	ThrowerAccountID int64
	ThrowerEntityID  *int
	ThrowerName      string
	ThrowerTeam      string
	Team1            string
	Team2            string

	// Координаты
	StartPos *TrajectoryPoint
	EndPos   *TrajectoryPoint

	// Траектория
	Trajectory           []TrajectoryPoint
	TrajectoryTicks      []int
	TrajectoryDense      []TrajectoryPoint
	TrajectoryDenseTicks []int

	// Entity ID гранаты
	ProjectileEntityID *int

	// Время полёта (в секундах)
	Airtime float64

	// Данные о броске
	ThrowKeys   string // LMB+W+JUMP
	Coordinates string // setpos X Y Z; setang P Y
}
