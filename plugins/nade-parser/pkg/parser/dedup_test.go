package parser

import (
	"nadesoulpars/pkg/models"
	"testing"
)

func TestDeduplicateGrenades_MergesCloseLineupsAndKeepsMostRepeatedDescription(t *testing.T) {
	input := []models.GrenadeData{
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   100,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 200,
			ExplodePosY: 200,
			ExplodePosZ: 30,
			ThrowKeys:   "LMB+W+JUMP",
			UsageCount:  3,
			Coordinates: "setpos 1 2 3; setang 4 5;",
			Trajectory:  [][]float64{{1, 2, 3}, {4, 5, 6}},
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   103,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 205,
			ExplodePosY: 200,
			ExplodePosZ: 31,
			ThrowKeys:   "lmb+w+jump",
			UsageCount:  2,
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   101,
			StartPosY:   99,
			StartPosZ:   9,
			ExplodePosX: 202,
			ExplodePosY: 204,
			ExplodePosZ: 30,
			ThrowKeys:   "RMB",
			UsageCount:  1,
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   140,
			StartPosY:   160,
			StartPosZ:   10,
			ExplodePosX: 280,
			ExplodePosY: 320,
			ExplodePosZ: 40,
			ThrowKeys:   "LMB",
		},
	}

	result, stats := DeduplicateGrenades(input)

	if len(result) != 2 {
		t.Fatalf("expected 2 grenades after deduplication, got %d", len(result))
	}

	if stats.RemovedCount != 2 {
		t.Fatalf("expected 2 removed duplicates, got %d", stats.RemovedCount)
	}

	first := result[0]
	if first.UsageCount != 6 {
		t.Fatalf("expected merged usage_count 6, got %d", first.UsageCount)
	}

	if first.ThrowKeys != "LMB+W+JUMP" {
		t.Fatalf("expected dominant throw keys LMB+W+JUMP, got %q", first.ThrowKeys)
	}

	if first.Coordinates == "" {
		t.Fatalf("expected representative with coordinates to be preserved")
	}

	if len(first.UsageThrowers) != 0 {
		t.Fatalf("expected empty usage throwers when throwers are absent, got %v", first.UsageThrowers)
	}
}

func TestDeduplicateGrenades_DoesNotMergeDifferentGrenadeTypes(t *testing.T) {
	input := []models.GrenadeData{
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   100,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 200,
			ExplodePosY: 200,
			ExplodePosZ: 30,
			ThrowKeys:   "LMB",
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "flash",
			StartPosX:   100,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 200,
			ExplodePosY: 200,
			ExplodePosZ: 30,
			ThrowKeys:   "LMB",
		},
	}

	result, _ := DeduplicateGrenades(input)
	if len(result) != 2 {
		t.Fatalf("expected different grenade types to stay separate, got %d", len(result))
	}
}

func TestDeduplicateGrenades_MergesCloseNeighborsWithinConfiguredTolerance(t *testing.T) {
	input := []models.GrenadeData{
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   1216,
			StartPosY:   -211,
			StartPosZ:   -163.96875,
			ExplodePosX: -1206.9375,
			ExplodePosY: -643.03125,
			ExplodePosZ: -165.96875,
			ThrowKeys:   "LMB+W+JUMP",
			UsageCount:  5,
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   1216,
			StartPosY:   -211,
			StartPosZ:   -163.96875,
			ExplodePosX: -1207.09375,
			ExplodePosY: -634.28125,
			ExplodePosZ: -165.96875,
			ThrowKeys:   "LMB+W+JUMP",
			UsageCount:  3,
		},
	}

	result, stats := DeduplicateGrenades(input)
	if len(result) != 1 {
		t.Fatalf("expected connected close neighbors to merge into 1 cluster, got %d", len(result))
	}

	if stats.RemovedCount != 1 {
		t.Fatalf("expected 1 removed duplicate, got %d", stats.RemovedCount)
	}

	if result[0].UsageCount != 8 {
		t.Fatalf("expected merged usage_count 8, got %d", result[0].UsageCount)
	}
}

func TestDeduplicateGrenades_DoesNotChainMergeAcrossClusterDiameter(t *testing.T) {
	input := []models.GrenadeData{
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   100,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 200,
			ExplodePosY: 200,
			ExplodePosZ: 30,
			ThrowKeys:   "LMB",
			UsageCount:  3,
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   104,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 211,
			ExplodePosY: 200,
			ExplodePosZ: 30,
			ThrowKeys:   "LMB",
			UsageCount:  2,
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   108,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 222,
			ExplodePosY: 200,
			ExplodePosZ: 30,
			ThrowKeys:   "LMB",
			UsageCount:  1,
		},
	}

	result, stats := DeduplicateGrenades(input)
	if len(result) != 2 {
		t.Fatalf("expected 2 clusters because the third grenade exceeds cluster diameter, got %d", len(result))
	}

	if stats.RemovedCount != 1 {
		t.Fatalf("expected 1 removed duplicate, got %d", stats.RemovedCount)
	}

	if result[0].UsageCount != 5 {
		t.Fatalf("expected first cluster merged usage_count 5, got %d", result[0].UsageCount)
	}
}

func TestDeduplicateGrenades_MergesOnlyPairsInsideConfiguredExplodeTolerance(t *testing.T) {
	input := []models.GrenadeData{
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   1296.0,
			StartPosY:   -352.0,
			StartPosZ:   -167.96875,
			ExplodePosX: -1193.1875,
			ExplodePosY: -639.53125,
			ExplodePosZ: -165.96875,
			ThrowKeys:   "LMB+W+JUMP",
			UsageCount:  6,
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   1296.0,
			StartPosY:   -352.0,
			StartPosZ:   -167.96875,
			ExplodePosX: -1195.21875,
			ExplodePosY: -606.625,
			ExplodePosZ: -165.96875,
			ThrowKeys:   "LMB+W+JUMP",
			UsageCount:  3,
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   1296.0,
			StartPosY:   -352.0,
			StartPosZ:   -167.96875,
			ExplodePosX: -1198.34375,
			ExplodePosY: -624.71875,
			ExplodePosZ: -165.96875,
			ThrowKeys:   "LMB+W+JUMP+DUCK",
			UsageCount:  1,
		},
	}

	result, stats := DeduplicateGrenades(input)
	if len(result) != 2 {
		t.Fatalf("expected 2 clusters because only one pair is inside configured tolerance, got %d", len(result))
	}

	if stats.RemovedCount != 1 {
		t.Fatalf("expected 1 removed duplicate, got %d", stats.RemovedCount)
	}

	foundMergedUsage := false
	for _, item := range result {
		if item.UsageCount == 7 {
			foundMergedUsage = true
		}
	}
	if !foundMergedUsage {
		t.Fatalf("expected one merged cluster with usage_count 7, got %#v", result)
	}
}

func TestDeduplicateGrenades_AggregatesUniqueThrowers(t *testing.T) {
	input := []models.GrenadeData{
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   100,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 200,
			ExplodePosY: 200,
			ExplodePosZ: 30,
			Thrower:     "donk",
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   101,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 205,
			ExplodePosY: 200,
			ExplodePosZ: 30,
			Thrower:     "zont1x",
		},
		{
			Map:         "Mirage",
			Side:        "T",
			GrenadeType: "smoke",
			StartPosX:   102,
			StartPosY:   100,
			StartPosZ:   10,
			ExplodePosX: 206,
			ExplodePosY: 199,
			ExplodePosZ: 30,
			Thrower:     "donk",
		},
	}

	result, _ := DeduplicateGrenades(input)
	if len(result) != 1 {
		t.Fatalf("expected 1 merged grenade, got %d", len(result))
	}

	got := result[0].UsageThrowers
	want := []string{"donk", "zont1x"}
	if len(got) != len(want) {
		t.Fatalf("expected %v throwers, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected throwers %v, got %v", want, got)
		}
	}
}

func TestDeduplicateGrenades_PreservesPreviouslyAggregatedUsageThrowers(t *testing.T) {
	input := []models.GrenadeData{
		{
			Map:           "Mirage",
			Side:          "T",
			GrenadeType:   "smoke",
			StartPosX:     100,
			StartPosY:     100,
			StartPosZ:     10,
			ExplodePosX:   200,
			ExplodePosY:   200,
			ExplodePosZ:   30,
			Thrower:       "donk",
			UsageThrowers: []string{"donk", "sh1ro"},
			UsageCount:    4,
		},
		{
			Map:           "Mirage",
			Side:          "T",
			GrenadeType:   "smoke",
			StartPosX:     103,
			StartPosY:     100,
			StartPosZ:     10,
			ExplodePosX:   205,
			ExplodePosY:   200,
			ExplodePosZ:   30,
			Thrower:       "zont1x",
			UsageThrowers: []string{"zont1x"},
			UsageCount:    2,
		},
	}

	result, _ := DeduplicateGrenades(input)
	if len(result) != 1 {
		t.Fatalf("expected 1 merged grenade, got %d", len(result))
	}

	got := result[0].UsageThrowers
	want := []string{"donk", "sh1ro", "zont1x"}
	if len(got) != len(want) {
		t.Fatalf("expected %v throwers, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected throwers %v, got %v", want, got)
		}
	}
}
