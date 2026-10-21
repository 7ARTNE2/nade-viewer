package parser

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
	"nadesoulpars/pkg/models"
	"nadesoulpars/pkg/utils"
)

func TestAirtimePairsOnlyExactProjectile(t *testing.T) {
	s := &grenadeAirtime{id: 1, entityID: 20, weapon: common.EqFlash, thrower: 100, throwTick: 100, tickRate: 64}
	tracker := &airtimeTracker{byID: map[int64]*grenadeAirtime{1: s}, byEntity: map[int]*grenadeAirtime{20: s}}
	for _, e := range []events.GrenadeEvent{
		{GrenadeEntityID: 21},
		{GrenadeEntityID: 20, Thrower: &common.Player{SteamID64: 101}},
	} {
		tracker.record(e, common.EqFlash, 204)
	}
	tracker.record(events.GrenadeEvent{GrenadeEntityID: 20}, common.EqSmoke, 204)
	tracker.record(events.GrenadeEvent{GrenadeEntityID: 20}, common.EqFlash, 99)
	if s.ended {
		t.Fatal("unrelated or invalid event ended the throw")
	}
	tracker.record(events.GrenadeEvent{GrenadeEntityID: 20}, common.EqFlash, 204)
	tracker.record(events.GrenadeEvent{GrenadeEntityID: 20}, common.EqFlash, 205)
	if got := tracker.seconds(1); got != 1.625 {
		t.Fatalf("duplicate changed airtime: %v", got)
	}
}

func TestAirtimeCleanupDoesNotInventDetonation(t *testing.T) {
	old := &grenadeAirtime{id: 1, entityID: 20, weapon: common.EqMolotov, throwTick: 100, tickRate: 64, destroyed: true}
	reused := &grenadeAirtime{id: 2, entityID: 20, weapon: common.EqSmoke, throwTick: 200, tickRate: 64}
	tracker := &airtimeTracker{byID: map[int64]*grenadeAirtime{1: old, 2: reused}, byEntity: map[int]*grenadeAirtime{20: reused}}
	tracker.deferUntilFrameDone(func() {
		if got := tracker.seconds(1); got != 0 {
			t.Fatalf("cleanup fabricated time: %v", got)
		}
	})
	tracker.flush()
	if tracker.byID[1] != nil || tracker.byEntity[20] != reused {
		t.Fatal("cleanup removed reused entity mapping")
	}
	tracker.deferUntilFrameDone(func() {
		if got := tracker.seconds(2); got != 0.5 {
			t.Fatalf("late deletion missing: %v", got)
		}
	})
	reused.finish(232)
	tracker.flush()
}

// Opt-in integration uses an independently captured event trace, including both
// replay formats. No demo or machine-specific paths are required by normal tests.
func TestAirtimeDemoIntegration(t *testing.T) {
	path, expectedPath := os.Getenv("NADE_AIRTIME_DEMO"), os.Getenv("NADE_AIRTIME_EXPECTED")
	if path == "" || expectedPath == "" {
		t.Skip("set NADE_AIRTIME_DEMO and NADE_AIRTIME_EXPECTED")
	}
	var trace struct {
		Throws []struct {
			Entity  int     `json:"entity"`
			Kind    string  `json:"kind"`
			Steam   uint64  `json:"steam_id"`
			Tick    int     `json:"throw_tick"`
			Airtime float64 `json:"airtime"`
		} `json:"throws"`
	}
	b, err := os.ReadFile(expectedPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &trace); err != nil {
		t.Fatal(err)
	}
	expected := map[string]float64{}
	canonicalExpected := 0
	key := func(entity int, steam uint64, tick int) string { return fmt.Sprintf("%d/%d/%d", entity, steam, tick) }
	for _, r := range trace.Throws {
		expected[key(r.Entity, r.Steam, r.Tick)] = r.Airtime
		if r.Kind != "decoy" {
			canonicalExpected++
		}
	}
	parsed, err := ParseDemoFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(parsed) != canonicalExpected {
		t.Fatalf("canonical count %d, want %d", len(parsed), canonicalExpected)
	}
	for _, g := range parsed {
		if g.ProjectileEntityID == nil {
			t.Fatal("missing entity ID")
		}
		found := false
		for _, offset := range []int{0, 11, 15} {
			if want, ok := expected[key(*g.ProjectileEntityID, uint64(g.ThrowerSteamID64), g.ThrowTick+offset)]; ok {
				found = true
				if g.Airtime != want {
					t.Errorf("canonical %s %d: %v, want %v", g.GrenadeType, g.ThrowTick, g.Airtime, want)
				}
				break
			}
		}
		if !found {
			t.Errorf("unmatched canonical throw %d", g.ThrowTick)
		}
	}
	checkReplay := func(t *testing.T, replayEvents []models.ReplayEvent) {
		ids := map[string]string{}
		count := 0
		for _, e := range replayEvents {
			switch e.Type {
			case "grenade_throw":
				entity := int(number(e.Data["grenade_entity_id"]))
				ids[fmt.Sprint(e.Data["projectile_id"])] = key(entity, e.PlayerSteamID64, e.Tick)
			case "grenade_destroy":
				k, ok := ids[fmt.Sprint(e.Data["projectile_id"])]
				if !ok {
					t.Fatal("destroy without throw")
				}
				want, ok := expected[k]
				if !ok {
					t.Fatalf("unknown replay throw %s", k)
				}
				if got := number(e.Data["airtime"]); got != want {
					t.Errorf("replay %s: %v, want %v", k, got, want)
				}
				count++
			}
		}
		if count != len(trace.Throws) {
			t.Fatalf("replay destroys %d, want %d", count, len(trace.Throws))
		}
	}
	t.Run("replay", func(t *testing.T) {
		r, err := ParseReplayFile(path, ReplayOptions{SampleFPS: 1})
		if err != nil {
			t.Fatal(err)
		}
		checkReplay(t, r.Events)
	})
	t.Run("streaming", func(t *testing.T) {
		var out strings.Builder
		if err := ParseReplayFileStreaming(path, ReplayOptions{SampleFPS: 1}, &out); err != nil {
			t.Fatal(err)
		}
		var all []models.ReplayEvent
		decoder := json.NewDecoder(strings.NewReader(out.String()))
		decoder.UseNumber()
		for decoder.More() {
			var line models.ReplayStreamLine
			if err := decoder.Decode(&line); err != nil {
				t.Fatal(err)
			}
			all = append(all, line.Events...)
		}
		checkReplay(t, all)
	})
}

func number(value any) float64 {
	switch v := value.(type) {
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case float64:
		return v
	case json.Number:
		f, err := v.Float64()
		if err != nil {
			panic(err)
		}
		return f
	default:
		panic(fmt.Sprintf("unexpected number %T", value))
	}
}

func TestDecoyDoesNotMapToHE(t *testing.T) {
	if got := utils.GetDjangoGrenadeType(common.EqDecoy.String()); got != "decoy" {
		t.Fatalf("got %q", got)
	}
}
