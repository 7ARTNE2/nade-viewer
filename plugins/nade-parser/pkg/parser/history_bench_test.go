package parser

import (
	"testing"

	"github.com/golang/geo/r3"
)

var benchmarkHistory []PositionSnapshot

func BenchmarkPositionHistory(b *testing.B) {
	b.Run("ring_push", func(b *testing.B) {
		history := newHistoryRing[PositionSnapshot]()
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			history.push(PositionSnapshot{Tick: i, Position: r3.Vector{X: float64(i)}})
		}
		benchmarkHistory = history.snapshotWith(PositionSnapshot{Tick: b.N})
	})

	b.Run("snapshot_at_throw", func(b *testing.B) {
		history := newHistoryRing[PositionSnapshot]()
		for i := 0; i < attackHistorySize; i++ {
			history.push(PositionSnapshot{Tick: i})
		}
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			benchmarkHistory = history.snapshotWith(PositionSnapshot{Tick: i})
		}
	})
}

func TestHistoryRingSnapshotDoesNotMutateStoredValues(t *testing.T) {
	history := newHistoryRing[PositionSnapshot]()
	history.push(PositionSnapshot{Tick: 123})

	got := history.snapshotWith(PositionSnapshot{Tick: 456})
	got[0].Tick = 789
	if history.values[0].Tick != 123 {
		t.Fatal("snapshot mutated stored history")
	}
	if got[len(got)-1].Tick != 456 {
		t.Fatal("missing latest snapshot")
	}
}
