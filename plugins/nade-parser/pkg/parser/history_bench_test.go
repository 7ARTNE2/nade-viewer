package parser

import (
	"github.com/golang/geo/r3"
	"testing"
)

var benchmarkHistory []PositionSnapshot

func BenchmarkPositionHistory(b *testing.B) {
	for _, optimized := range []bool{false, true} {
		name := "baseline"
		if optimized {
			name = "optimized"
		}
		b.Run(name, func(b *testing.B) {
			history := make([]PositionSnapshot, attackHistorySize)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if optimized {
					history = appendCurrentPosition(history, i, r3.Vector{}, 0, 0)
				} else {
					out := append([]PositionSnapshot{}, history...)
					out = append(out, PositionSnapshot{Tick: i})
					history = out[len(out)-attackHistorySize:]
				}
			}
			benchmarkHistory = history
		})
	}
}

func TestHistoryDoesNotMutateInput(t *testing.T) {
	history := make([]PositionSnapshot, attackHistorySize, attackHistorySize+1)
	history[0].Tick = 123
	got := appendCurrentPosition(history, 456, r3.Vector{}, 0, 0)
	got[0].Tick = 789
	if history[0].Tick != 123 || history[1].Tick != 0 {
		t.Fatal("input history was mutated")
	}
	if got[len(got)-1].Tick != 456 {
		t.Fatal("missing latest snapshot")
	}
}
