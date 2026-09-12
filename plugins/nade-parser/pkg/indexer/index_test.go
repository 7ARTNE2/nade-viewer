package indexer

import (
	"path/filepath"
	"testing"

	"nadesoulpars/pkg/models"
)

func TestStateSaveLoadRoundTrip(t *testing.T) {
	tmp := t.TempDir()
	path := filepath.Join(tmp, "grenade_index.json")

	state := NewState()
	state.Canonical = []models.GrenadeData{
		{Map: "Mirage", Side: "T", GrenadeType: "smoke", UsageCount: 3},
	}
	state.MarkProcessed([]string{"a.dem", "b.dem", "a.dem"})

	if err := state.Save(path); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}

	if len(loaded.Canonical) != 1 {
		t.Fatalf("expected 1 canonical grenade, got %d", len(loaded.Canonical))
	}

	if len(loaded.ProcessedDemos) != 2 {
		t.Fatalf("expected 2 processed demos, got %d", len(loaded.ProcessedDemos))
	}
}

func TestStateSaveLoadMessagePackRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "grenade_index.msgpack")
	state := NewState()
	state.Canonical = []models.GrenadeData{
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			UsageCount:  3,
			Trajectory: [][]float64{
				{10.5, 20.25, 30.75},
			},
		},
	}
	state.MarkProcessed([]string{"b.dem", "a.dem"})

	if err := state.Save(path); err != nil {
		t.Fatalf("save failed: %v", err)
	}

	loaded, err := Load(path)
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if len(loaded.Canonical) != 1 || loaded.Canonical[0].Map != "Mirage" {
		t.Fatalf("unexpected canonical grenades: %#v", loaded.Canonical)
	}
	if len(loaded.Canonical[0].Trajectory) != 1 {
		t.Fatalf("trajectory was not preserved: %#v", loaded.Canonical[0].Trajectory)
	}
	if len(loaded.ProcessedDemos) != 2 || loaded.ProcessedDemos[0] != "a.dem" {
		t.Fatalf("unexpected processed demos: %#v", loaded.ProcessedDemos)
	}
}
