package parser

import (
	"encoding/json"
	"io"
	"os"
	"reflect"
	"sort"
	"testing"

	"nadesoulpars/pkg/models"
)

// Set NADE_REPLAY_DEMO to run this contract against a local, untracked demo.
func TestReplayGrenadesMatchCanonical(t *testing.T) {
	path := os.Getenv("NADE_REPLAY_DEMO")
	if path == "" {
		t.Skip("NADE_REPLAY_DEMO is not set")
	}
	canonical, err := ParseAndConvertWithOptions(path, DefaultOutputOptions())
	if err != nil {
		t.Fatal(err)
	}
	if baselinePath := os.Getenv("NADE_REPLAY_BASELINE"); baselinePath != "" {
		bytes, err := os.ReadFile(baselinePath)
		if err != nil {
			t.Fatal(err)
		}
		var baseline struct {
			Grenades []models.GrenadeData `json:"canonical_grenades"`
		}
		if err := json.Unmarshal(bytes, &baseline); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(canonical, baseline.Grenades) {
			t.Fatal("canonical output changed from the pre-refactor baseline")
		}
	}
	for _, fps := range []float64{1, 16} {
		replay, err := ParseReplayFile(path, ReplayOptions{SampleFPS: fps})
		if err != nil {
			t.Fatal(err)
		}
		actual := make([]models.GrenadeData, 0, len(replay.Grenades))
		for _, grenade := range replay.Grenades {
			if grenade.ReleaseTick < grenade.Data.ThrowTick {
				t.Fatal("lineup tick exceeds release tick")
			}
			actual = append(actual, grenade.Data)
		}
		order := func(items []models.GrenadeData) []string {
			result := make([]string, len(items))
			for i, item := range items {
				encoded, _ := json.Marshal(item)
				result[i] = string(encoded)
			}
			sort.Strings(result)
			return result
		}
		if !reflect.DeepEqual(order(canonical), order(actual)) {
			t.Fatalf("replay %.0f FPS differs from canonical (%d vs %d)", fps, len(actual), len(canonical))
		}
		if len(replay.Frames) == 0 || len(replay.Rounds) == 0 {
			t.Fatal("empty replay")
		}
		if fps == 16 && replay.Metadata.TickRate == 64 {
			for i := 1; i < len(replay.Frames); i++ {
				a, b := replay.Frames[i-1], replay.Frames[i]
				if a.RoundNumber == b.RoundNumber && (b.Tick-a.Tick)%4 != 0 {
					t.Fatalf("expected a frame every four ticks, got %d", b.Tick-a.Tick)
				}
			}
		}
	}
	streamed := 0
	err = collectReplay(path, ReplayOptions{SampleFPS: 16}, func(line models.ReplayStreamLine) error {
		if line.Type == "grenade" {
			encoded, err := json.Marshal(line.Grenade)
			if err != nil {
				return err
			}
			var decoded models.ReplayGrenade
			if err = json.Unmarshal(encoded, &decoded); err != nil {
				return err
			}
			if !reflect.DeepEqual(decoded.Data, line.Grenade.Data) {
				t.Fatal("replay serialization changed canonical data")
			}
			streamed++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if streamed != len(canonical) {
		t.Fatalf("streamed %d grenades, want %d", streamed, len(canonical))
	}
}

func TestReplayRejectsInvalidSamplingBeforeOpeningDemo(t *testing.T) {
	if err := ParseReplayFileStreaming("missing.dem", ReplayOptions{SampleFPS: 65}, io.Discard); err == nil {
		t.Fatal("invalid sample FPS accepted")
	}
}
