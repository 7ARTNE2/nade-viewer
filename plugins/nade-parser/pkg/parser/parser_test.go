package parser

import (
	"encoding/json"
	"strings"
	"testing"

	"nadesoulpars/pkg/models"

	"github.com/golang/geo/r3"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

func TestHistoryRing_OrdersAndTrimsHistory(t *testing.T) {
	history := newHistoryRing[uint64]()
	for i := 0; i < attackHistorySize; i++ {
		history.push(uint64(i + 1))
	}

	got := history.snapshotWith(999)
	if len(got) != attackHistorySize {
		t.Fatalf("expected history size %d, got %d", attackHistorySize, len(got))
	}
	if got[len(got)-1] != 999 {
		t.Fatalf("expected last entry to be current buttons, got %d", got[len(got)-1])
	}
	if got[0] != 2 {
		t.Fatalf("expected oldest entry to be trimmed, got first entry %d", got[0])
	}
}

func TestResolveForwardJumpRunupReturnsStartOfFinalForwardHold(t *testing.T) {
	w := uint64(common.ButtonForward)
	jump := uint64(common.ButtonJump)
	history := []uint64{uint64(common.ButtonBack), w, w, w, w, w, w | jump, jump}
	positions := make([]PositionSnapshot, len(history))
	for i := range positions {
		positions[i] = PositionSnapshot{Tick: 100 + i, Position: r3.Vector{X: float64(i)}}
	}

	got := resolveForwardJumpRunup(history, positions)
	if got == nil || got.Tick != 101 || got.Position.X != 1 {
		t.Fatalf("expected final W run-up to start at tick 101, got %#v", got)
	}
}

func TestResolveForwardJumpRunupRejectsAimAdjustment(t *testing.T) {
	w := uint64(common.ButtonForward)
	jump := uint64(common.ButtonJump)
	history := []uint64{w, w, w, w, w, w, w, w, w, w | jump}
	positions := []PositionSnapshot{
		{Tick: 100, Yaw: 0},
		{Tick: 101, Yaw: 5},
		{Tick: 102, Yaw: 10},
		{Tick: 103, Yaw: 15},
		{Tick: 104, Yaw: 20},
		{Tick: 105, Yaw: 25},
		{Tick: 106, Yaw: 30},
		{Tick: 107, Yaw: 35},
	}

	if got := resolveForwardJumpRunup(history, positions); got != nil {
		t.Fatalf("expected aim-adjusted run-up to use the regular stable-aim resolver, got %#v", got)
	}
}

func TestResolveForwardJumpRunupUsesStableAimAfterLongRunup(t *testing.T) {
	w := uint64(common.ButtonForward)
	jump := uint64(common.ButtonJump)
	history := []uint64{w, w, w, w, w, w, w, w, w, w | jump}
	positions := []PositionSnapshot{
		{Tick: 100, Yaw: 0},
		{Tick: 101, Yaw: 5},
		{Tick: 102, Yaw: 10},
		{Tick: 103, Yaw: 30},
		{Tick: 104, Yaw: 30},
		{Tick: 105, Yaw: 30},
		{Tick: 106, Yaw: 30},
		{Tick: 107, Yaw: 30},
		{Tick: 108, Yaw: 30},
		{Tick: 109, Yaw: 30},
	}

	got := resolveForwardJumpRunup(history, positions)
	if got == nil || got.Tick != 103 {
		t.Fatalf("expected stable aim to start at tick 103, got %#v", got)
	}
}

func TestResolveForwardJumpRunupUsesGroundTickWhenForwardAndJumpStartTogether(t *testing.T) {
	w := uint64(common.ButtonForward)
	jump := uint64(common.ButtonJump)
	history := []uint64{0, w | jump, w | jump, w | jump}
	positions := []PositionSnapshot{
		{Tick: 100, Position: r3.Vector{Z: 10}},
		{Tick: 101, Position: r3.Vector{Z: 13}},
		{Tick: 102, Position: r3.Vector{Z: 17}},
		{Tick: 103, Position: r3.Vector{Z: 20}},
	}

	got := resolveForwardJumpRunup(history, positions)
	if got == nil || got.Tick != 100 || got.Position.Z != 10 {
		t.Fatalf("expected final ground position at tick 100, got %#v", got)
	}
}

func TestResolveForwardJumpRunupUsesForwardHeldBeforeJump(t *testing.T) {
	w := uint64(common.ButtonForward)
	jump := uint64(common.ButtonJump)
	history := []uint64{w, w, w, w, w, jump, jump}
	positions := []PositionSnapshot{
		{Tick: 100, Yaw: 20},
		{Tick: 101, Yaw: 20},
		{Tick: 102, Yaw: 20},
		{Tick: 103, Yaw: 20},
		{Tick: 104, Yaw: 20},
		{Tick: 105, Yaw: 20},
		{Tick: 106, Yaw: 20},
	}

	got := resolveForwardJumpRunup(history, positions)
	if got == nil || got.Tick != 104 {
		t.Fatalf("expected final W tick at 104, got %#v", got)
	}
}

func TestGroundSnapshotBeforeJumpUsesPositionWhenJumpButtonIsMissing(t *testing.T) {
	positions := []PositionSnapshot{
		{Tick: 100, Position: r3.Vector{Z: 10}},
		{Tick: 101, Position: r3.Vector{Z: 13}},
		{Tick: 102, Position: r3.Vector{Z: 17}},
	}

	got := groundSnapshotBeforeJump(positions, &positions[2])
	if got == nil || got.Tick != 100 || got.Position.Z != 10 {
		t.Fatalf("expected ground snapshot at tick 100, got %#v", got)
	}
}

func TestGroundSnapshotBeforeJumpIgnoresTerrainSlope(t *testing.T) {
	positions := []PositionSnapshot{
		{Tick: 100, Position: r3.Vector{Z: 10}},
		{Tick: 101, Position: r3.Vector{Z: 10.2}},
		{Tick: 102, Position: r3.Vector{Z: 10.4}},
	}

	got := groundSnapshotBeforeJump(positions, &positions[2])
	if got == nil || got.Tick != 102 {
		t.Fatalf("expected terrain slope to keep current snapshot, got %#v", got)
	}
}

func TestGetThrowKeys_UsesCurrentTickButtonsAtThrow(t *testing.T) {
	currentButtons := uint64(common.ButtonAttack | common.ButtonAttack2 | common.ButtonForward | common.ButtonJump | common.ButtonSpeed)
	player := &common.Player{ButtonsPressedState: currentButtons}

	desc := getThrowKeys(player, []uint64{currentButtons})
	parts := strings.Split(desc, "+")
	got := map[string]bool{}
	for _, part := range parts {
		got[part] = true
	}

	for _, expected := range []string{"LMB", "RMB", "W", "JUMP", "SHIFT"} {
		if !got[expected] {
			t.Fatalf("expected throw description %q to contain %q", desc, expected)
		}
	}
}

func TestGetThrowKeys_IgnoresOldDuckUsedBeforeThrow(t *testing.T) {
	attackHistory := []uint64{
		uint64(common.ButtonDuck),
		uint64(common.ButtonDuck),
		0,
		0,
		0,
		uint64(common.ButtonAttack),
		uint64(common.ButtonAttack | common.ButtonForward),
		uint64(common.ButtonAttack | common.ButtonForward),
		uint64(common.ButtonAttack | common.ButtonForward | common.ButtonJump),
		uint64(common.ButtonForward | common.ButtonJump),
	}
	player := &common.Player{
		ButtonsPressedState: attackHistory[len(attackHistory)-1],
	}

	desc := getThrowKeys(player, attackHistory)
	if strings.Contains(desc, "DUCK") {
		t.Fatalf("expected old duck to be ignored, got %q", desc)
	}
	if desc != "LMB+W+JUMP" {
		t.Fatalf("expected LMB+W+JUMP, got %q", desc)
	}
}

func TestGetThrowKeys_KeepsRecentDuckAtThrow(t *testing.T) {
	attackHistory := []uint64{
		0,
		0,
		uint64(common.ButtonDuck),
		uint64(common.ButtonAttack | common.ButtonDuck),
		uint64(common.ButtonAttack | common.ButtonDuck),
		uint64(common.ButtonAttack | common.ButtonDuck),
	}
	player := &common.Player{
		ButtonsPressedState: attackHistory[len(attackHistory)-1],
	}

	desc := getThrowKeys(player, attackHistory)
	if !strings.Contains(desc, "DUCK") {
		t.Fatalf("expected recent duck to be preserved, got %q", desc)
	}
}

func TestResolveLineupStart_MovementUsesStableSetposTick(t *testing.T) {
	attackHistory := []uint64{
		0,
		0,
		0,
		0,
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
	}
	posHistory := []PositionSnapshot{
		{Tick: 100, Position: r3.Vector{X: 10, Y: 20, Z: 30}},
		{Tick: 101, Position: r3.Vector{X: 10, Y: 20, Z: 30}},
		{Tick: 102, Position: r3.Vector{X: 10, Y: 20, Z: 30}},
		{Tick: 103, Position: r3.Vector{X: 10, Y: 20, Z: 30}},
		{Tick: 104, Position: r3.Vector{X: 15, Y: 20, Z: 30}},
		{Tick: 105, Position: r3.Vector{X: 20, Y: 20, Z: 30}},
	}

	pos, snapshot := resolveLineupStart(attackHistory, posHistory, "LMB+W", 105)

	if pos == nil {
		t.Fatal("expected lineup position override")
	}
	if snapshot != nil {
		t.Fatalf("expected no lineup snapshot override, got %+v", *snapshot)
	}
	if pos.X != 10 || pos.Y != 20 || pos.Z != 30 {
		t.Fatalf("unexpected lineup position: %+v", *pos)
	}
}

func TestResolveLineupStart_JumpWithoutMovementUsesStablePreJumpTick(t *testing.T) {
	attackHistory := []uint64{
		0,
		0,
		0,
		0,
		uint64(common.ButtonJump),
		uint64(common.ButtonJump),
	}
	posHistory := []PositionSnapshot{
		{Tick: 200, Position: r3.Vector{X: 5, Y: 6, Z: 7}},
		{Tick: 201, Position: r3.Vector{X: 5, Y: 6, Z: 7}},
		{Tick: 202, Position: r3.Vector{X: 5, Y: 6, Z: 7}},
		{Tick: 203, Position: r3.Vector{X: 5, Y: 6, Z: 7}},
		{Tick: 204, Position: r3.Vector{X: 5, Y: 6, Z: 9}},
		{Tick: 205, Position: r3.Vector{X: 5, Y: 6, Z: 12}},
	}

	pos, snapshot := resolveLineupStart(attackHistory, posHistory, "LMB+JUMP", 205)

	if pos == nil {
		t.Fatal("expected lineup position override")
	}
	if snapshot != nil {
		t.Fatalf("expected no lineup snapshot override, got %+v", *snapshot)
	}
	if pos.X != 5 || pos.Y != 6 || pos.Z != 7 {
		t.Fatalf("unexpected lineup position: %+v", *pos)
	}
}

func TestResolveLineupStart_DefaultThrowUsesTwoTicksBackSnapshot(t *testing.T) {
	attackHistory := []uint64{0, 0, 0}
	posHistory := []PositionSnapshot{
		{Tick: 300, Position: r3.Vector{X: 1, Y: 2, Z: 3}, Pitch: -10, Yaw: 90},
		{Tick: 301, Position: r3.Vector{X: 2, Y: 2, Z: 3}, Pitch: -5, Yaw: 95},
		{Tick: 302, Position: r3.Vector{X: 3, Y: 2, Z: 3}, Pitch: 0, Yaw: 100},
	}

	pos, snapshot := resolveLineupStart(attackHistory, posHistory, "LMB", 302)

	if pos != nil {
		t.Fatalf("expected no override position, got %+v", *pos)
	}
	if snapshot == nil {
		t.Fatal("expected two-ticks-back lineup snapshot")
	}
	if snapshot.Tick != 300 {
		t.Fatalf("expected snapshot tick 300, got %d", snapshot.Tick)
	}
}

func TestAlignJumpLineupToStartTick_UsesStartTickSnapshotForCoordinates(t *testing.T) {
	posHistory := []PositionSnapshot{
		{Tick: 500, Position: r3.Vector{X: 1, Y: 2, Z: 3}, Pitch: -10, Yaw: 90},
		{Tick: 501, Position: r3.Vector{X: 4, Y: 5, Z: 6}, Pitch: -12.5, Yaw: 101.25},
		{Tick: 502, Position: r3.Vector{X: 7, Y: 8, Z: 9}, Pitch: -14, Yaw: 110},
	}

	gotPos, gotSnapshot := alignJumpLineupToStartTick(
		nil,
		nil,
		posHistory,
		"LMB+JUMP",
		501,
	)

	if gotPos != nil {
		t.Fatalf("expected override position to be replaced by snapshot, got %+v", *gotPos)
	}
	if gotSnapshot == nil {
		t.Fatal("expected jump lineup snapshot")
	}
	if gotSnapshot.Tick != 501 {
		t.Fatalf("expected snapshot tick 501, got %d", gotSnapshot.Tick)
	}
}

func TestAlignJumpLineupToStartTick_KeepsResolvedOriginForMovingJumpThrow(t *testing.T) {
	startPosOverride := &models.TrajectoryPoint{X: 10, Y: 20, Z: 30}
	posHistory := []PositionSnapshot{
		{Tick: 500, Position: r3.Vector{X: 1, Y: 2, Z: 3}, Pitch: -10, Yaw: 90},
		{Tick: 501, Position: r3.Vector{X: 4, Y: 5, Z: 6}, Pitch: -12.5, Yaw: 101.25},
	}

	gotPos, gotSnapshot := alignJumpLineupToStartTick(
		startPosOverride,
		nil,
		posHistory,
		"LMB+W+JUMP",
		501,
	)

	if gotPos == nil {
		t.Fatal("expected resolved origin to be preserved")
	}
	if gotPos.X != 10 || gotPos.Y != 20 || gotPos.Z != 30 {
		t.Fatalf("unexpected preserved origin: %+v", *gotPos)
	}
	if gotSnapshot != nil {
		t.Fatalf("expected no snapshot replacement, got %+v", *gotSnapshot)
	}
}

func TestNormalizeThrowKeys_StripsTransitMovementBeforeJump(t *testing.T) {
	attackHistory := []uint64{
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		0,
		0,
		0,
		0,
		0,
		uint64(common.ButtonJump),
		uint64(common.ButtonJump),
		uint64(common.ButtonJump),
	}
	posHistory := []PositionSnapshot{
		{Tick: 100, Position: r3.Vector{X: 0, Y: 0, Z: 0}},
		{Tick: 101, Position: r3.Vector{X: 8, Y: 0, Z: 0}},
		{Tick: 102, Position: r3.Vector{X: 16, Y: 0, Z: 0}},
		{Tick: 103, Position: r3.Vector{X: 24, Y: 0, Z: 0}},
		{Tick: 104, Position: r3.Vector{X: 24, Y: 0, Z: 0}},
		{Tick: 105, Position: r3.Vector{X: 24, Y: 0, Z: 0}},
		{Tick: 106, Position: r3.Vector{X: 24, Y: 0, Z: 0}},
		{Tick: 107, Position: r3.Vector{X: 24, Y: 0, Z: 0}},
		{Tick: 108, Position: r3.Vector{X: 24, Y: 0, Z: 0}},
		{Tick: 109, Position: r3.Vector{X: 24, Y: 0, Z: 4}},
		{Tick: 110, Position: r3.Vector{X: 24, Y: 0, Z: 10}},
		{Tick: 111, Position: r3.Vector{X: 24, Y: 0, Z: 18}},
	}

	got := normalizeThrowKeys(attackHistory, posHistory, "LMB+W+JUMP")
	if got != "LMB+JUMP" {
		t.Fatalf("expected transit movement to be stripped, got %q", got)
	}
}

func TestNormalizeThrowKeys_KeepsRealMovingJumpThrow(t *testing.T) {
	attackHistory := []uint64{
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward),
		uint64(common.ButtonForward | common.ButtonJump),
		uint64(common.ButtonForward | common.ButtonJump),
		uint64(common.ButtonForward | common.ButtonJump),
	}
	posHistory := []PositionSnapshot{
		{Tick: 200, Position: r3.Vector{X: 0, Y: 0, Z: 0}},
		{Tick: 201, Position: r3.Vector{X: 8, Y: 0, Z: 0}},
		{Tick: 202, Position: r3.Vector{X: 16, Y: 0, Z: 0}},
		{Tick: 203, Position: r3.Vector{X: 24, Y: 0, Z: 0}},
		{Tick: 204, Position: r3.Vector{X: 32, Y: 0, Z: 0}},
		{Tick: 205, Position: r3.Vector{X: 40, Y: 0, Z: 0}},
		{Tick: 206, Position: r3.Vector{X: 48, Y: 0, Z: 0}},
		{Tick: 207, Position: r3.Vector{X: 56, Y: 0, Z: 0}},
		{Tick: 208, Position: r3.Vector{X: 64, Y: 0, Z: 4}},
		{Tick: 209, Position: r3.Vector{X: 72, Y: 0, Z: 10}},
		{Tick: 210, Position: r3.Vector{X: 80, Y: 0, Z: 18}},
	}

	got := normalizeThrowKeys(attackHistory, posHistory, "LMB+W+JUMP")
	if got != "LMB+W+JUMP" {
		t.Fatalf("expected real moving jumpthrow to be preserved, got %q", got)
	}
}

func TestNormalizeThrowKeys_KeepsShortRunupThatContinuesIntoJump(t *testing.T) {
	attackHistory := []uint64{
		0,
		0,
		0,
		0,
		0,
		uint64(common.ButtonForward | common.ButtonJump),
		uint64(common.ButtonForward | common.ButtonJump),
		uint64(common.ButtonForward | common.ButtonJump),
		uint64(common.ButtonForward),
		0,
	}
	posHistory := []PositionSnapshot{
		{Tick: 100, Position: r3.Vector{X: 0, Y: 0, Z: 0}},
		{Tick: 101, Position: r3.Vector{X: 0, Y: 0, Z: 0}},
		{Tick: 102, Position: r3.Vector{X: 0, Y: 0, Z: 0}},
		{Tick: 103, Position: r3.Vector{X: 0, Y: 0, Z: 0}},
		{Tick: 104, Position: r3.Vector{X: 0, Y: 0, Z: 0}},
		{Tick: 105, Position: r3.Vector{X: 1, Y: 0, Z: 4}},
		{Tick: 106, Position: r3.Vector{X: 2, Y: 0, Z: 10}},
		{Tick: 107, Position: r3.Vector{X: 3, Y: 0, Z: 18}},
		{Tick: 108, Position: r3.Vector{X: 4, Y: 0, Z: 22}},
		{Tick: 109, Position: r3.Vector{X: 4, Y: 0, Z: 24}},
	}

	got := normalizeThrowKeys(attackHistory, posHistory, "LMB+W+JUMP")
	if got != "LMB+W+JUMP" {
		t.Fatalf("expected short run-up into jump to be preserved, got %q", got)
	}
}

func TestGetPlayerState_UsesSnapshotAnglesForDefaultThrow(t *testing.T) {
	playerState := getPlayerState(
		&common.Player{},
		"LMB",
		nil,
		&PositionSnapshot{
			Tick:     300,
			Position: r3.Vector{X: 1, Y: 2, Z: 3},
			Pitch:    -12.5,
			Yaw:      101.25,
		},
	)

	if playerState == nil {
		t.Fatal("expected player state")
	}
	if playerState.Position.X != 1 || playerState.Position.Y != 2 || playerState.Position.Z != 3 {
		t.Fatalf("unexpected player position: %+v", playerState.Position)
	}
	if playerState.Pitch != -12.5 || playerState.Yaw != 101.25 {
		t.Fatalf("expected snapshot angles (-12.5, 101.25), got (%v, %v)", playerState.Pitch, playerState.Yaw)
	}
}

func TestConvertToGrenadeData_ExportsOnlyViewerFields(t *testing.T) {
	throwerEntityID := 7
	projectileEntityID := 42
	data := ConvertToGrenadeData(&models.ParsedGrenade{
		MapName:            "Mirage",
		Side:               "T",
		GrenadeType:        "smoke",
		ThrowerSteamID64:   76561198000000001,
		ThrowerEntityID:    &throwerEntityID,
		ProjectileEntityID: &projectileEntityID,
		ThrowerTeam:        "PARIVISION",
		StartPos:           &models.TrajectoryPoint{X: 1, Y: 2, Z: 3},
	})

	if data.ThrowerTeam != "PARIVISION" {
		t.Fatalf("expected thrower team to be preserved, got %q", data.ThrowerTeam)
	}
	if data.ThrowerEntityID == nil || *data.ThrowerEntityID != throwerEntityID {
		t.Fatalf("expected thrower entity id to be included")
	}
	if data.ProjectileEntityID == nil || *data.ProjectileEntityID != projectileEntityID {
		t.Fatalf("expected projectile entity id to be included")
	}

	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal grenade data: %v", err)
	}
	if !strings.Contains(string(encoded), "start_pos_z") {
		t.Fatalf("start_pos_z must be serialized for Viewer-side deduplication: %s", encoded)
	}
}

func TestConvertToGrenadeDataWithOptions_ControlsSupportedIDs(t *testing.T) {
	throwerEntityID := 7
	projectileEntityID := 42

	data := ConvertToGrenadeDataWithOptions(&models.ParsedGrenade{
		MapName:            "Mirage",
		Side:               "T",
		GrenadeType:        "smoke",
		ThrowerSteamID64:   76561198000000001,
		ThrowerEntityID:    &throwerEntityID,
		ProjectileEntityID: &projectileEntityID,
	}, OutputOptions{
		IncludeThrowerSteamID64:   false,
		IncludeThrowerEntityID:    false,
		IncludeProjectileEntityID: false,
	})

	if data.ThrowerSteamID64 != 0 || data.ThrowerEntityID != nil || data.ProjectileEntityID != nil {
		t.Fatalf("expected all configurable ID fields to be omitted, got %+v", data)
	}
}
