package parser

import (
	"math"

	demoinfocs "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

type grenadeAirtime struct {
	id        int64
	entityID  int
	weapon    common.EquipmentType
	thrower   uint64
	throwTick int
	tickRate  float64
	endTick   int
	ended     bool
	destroyed bool
}

type airtimeTracker struct {
	byID       map[int64]*grenadeAirtime
	byEntity   map[int]*grenadeAirtime
	afterFrame []func()
}

// registerAirtimeTracker must precede consumers' handlers. Entity deletion and
// detonation events can follow GrenadeProjectileDestroy in the same demo frame.
func registerAirtimeTracker(p demoinfocs.Parser) *airtimeTracker {
	t := &airtimeTracker{byID: make(map[int64]*grenadeAirtime), byEntity: make(map[int]*grenadeAirtime)}
	p.RegisterEventHandler(func(e events.GrenadeProjectileThrow) {
		g := e.Projectile
		if g == nil || g.Entity == nil || g.WeaponInstance == nil {
			return
		}
		state := &grenadeAirtime{id: g.UniqueID(), entityID: g.Entity.ID(), weapon: g.WeaponInstance.Type,
			throwTick: p.GameState().IngameTick(), tickRate: p.TickRate()}
		if g.Thrower != nil {
			state.thrower = g.Thrower.SteamID64
		}
		t.byID[state.id] = state
		t.byEntity[state.entityID] = state
		if state.weapon == common.EqMolotov || state.weapon == common.EqIncendiary {
			// MatchZy measures fire grenades on actual entity deletion. The parser
			// also synthesizes ProjectileDestroy during round cleanup; do not use it.
			g.Entity.OnDestroy(func() { state.finish(p.GameState().IngameTick()) })
		}
	})
	p.RegisterEventHandler(func(e events.HeExplode) { t.record(e.GrenadeEvent, common.EqHE, p.GameState().IngameTick()) })
	p.RegisterEventHandler(func(e events.FlashExplode) { t.record(e.GrenadeEvent, common.EqFlash, p.GameState().IngameTick()) })
	p.RegisterEventHandler(func(e events.SmokeStart) { t.record(e.GrenadeEvent, common.EqSmoke, p.GameState().IngameTick()) })
	p.RegisterEventHandler(func(e events.DecoyStart) { t.record(e.GrenadeEvent, common.EqDecoy, p.GameState().IngameTick()) })
	p.RegisterEventHandler(func(e events.GrenadeProjectileDestroy) {
		if e.Projectile != nil {
			if state := t.byID[e.Projectile.UniqueID()]; state != nil {
				state.destroyed = true
			}
		}
	})
	p.RegisterEventHandler(func(events.FrameDone) { t.flush() })
	return t
}

func (s *grenadeAirtime) finish(tick int) {
	if !s.ended && tick >= s.throwTick {
		s.endTick = tick
		s.ended = true
	}
}

func (t *airtimeTracker) record(e events.GrenadeEvent, weapon common.EquipmentType, tick int) {
	s := t.byEntity[e.GrenadeEntityID]
	if s == nil || s.weapon != weapon {
		return
	}
	if e.Thrower != nil && s.thrower != e.Thrower.SteamID64 {
		return
	}
	s.finish(tick)
}

func (t *airtimeTracker) seconds(id int64) float64 {
	s := t.byID[id]
	if s == nil || !s.ended || s.tickRate <= 0 || math.IsNaN(s.tickRate) || math.IsInf(s.tickRate, 0) {
		return 0
	}
	return float64(s.endTick-s.throwTick) / s.tickRate
}

func (t *airtimeTracker) deferUntilFrameDone(fn func()) { t.afterFrame = append(t.afterFrame, fn) }

func (t *airtimeTracker) flush() {
	callbacks := t.afterFrame
	t.afterFrame = nil
	for _, fn := range callbacks {
		fn()
	}
	for id, s := range t.byID {
		if s.destroyed {
			delete(t.byID, id)
			if t.byEntity[s.entityID] == s {
				delete(t.byEntity, s.entityID)
			}
		}
	}
}
