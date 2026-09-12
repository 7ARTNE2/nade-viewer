package parser

// grenade_v2.go — основной алгоритм детекции гранат (точка входа DemoParser.Parse).
// ParseLegacy (parser.go) сохранён как референс для сравнения.
//
// Ключевые отличия от ParseLegacy:
//   - Точка БРОСКА (lineup) определяется по реальному финальному заходу игрока
//     (resolveGrenadeLineupV2), а не отматыванием к "стабильной точке до начала
//     движения", которое при долгом разбеге улетало на спавн:
//       * бросок в движении  -> resolveMovingReleaseLineup (смена направления
//         движения + фиксация прицела по yaw);
//       * прыжок с места      -> resolveStandingJumpLineup (позиция перед отрывом
//         от земли по Z);
//       * стационарный бросок -> прежняя логика resolveLineupStart.
//   - Точка ПРИЗЕМЛЕНИЯ (explode_pos) берётся из последней точки Projectile.Trajectory
//     для всех типов (как в legacy). Explode-события движка для позиции НЕ
//     используются: их GrenadeEntityID ненадёжно сопоставляется со снарядом и
//     путает близкие по времени броски (double-flash, повторные молотовы).
//   - airtime считается как в legacy: трекер остановки смока/молотова через
//     FrameDone даёт реальное время полёта; HE/flash = 1.6.
//
// throw_keys, координаты и часть lineup-логики переиспользуют общие
// helper-ы из parser.go (getThrowKeys, resolveLineupStart, getPlayerState).

import (
	"fmt"
	"math"
	"os"
	"strconv"

	"nadesoulpars/pkg/models"
	"nadesoulpars/pkg/utils"

	"github.com/golang/geo/r3"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
	msg "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/msg"
)

// debugDumpThrow выводит историю позиций/кнопок вокруг броска, если задана
// переменная окружения NADE_DEBUG_TICK (тик броска, +-окно). Только для отладки.
func debugDumpThrow(currentTick int, name, grenadeType, rawDesc, normDesc string, attackHistory []uint64, posHistory []PositionSnapshot) {
	want := os.Getenv("NADE_DEBUG_TICK")
	if want == "" {
		return
	}
	target, err := strconv.Atoi(want)
	if err != nil {
		return
	}
	if currentTick < target-30 || currentTick > target+30 {
		return
	}
	fmt.Fprintf(os.Stderr, "\n=== THROW name=%s type=%s tick=%d rawDesc=%q normDesc=%q ===\n", name, grenadeType, currentTick, rawDesc, normDesc)
	// Окно лога: с (target-1042) по конец истории, чтобы покрыть запрошенный диапазон.
	logFromTick := target - 1042
	n := len(posHistory)
	from := 0
	for i := 0; i < n; i++ {
		if posHistory[i].Tick >= logFromTick {
			from = i
			break
		}
	}
	prev := posHistory[from]
	for i := from; i < n; i++ {
		s := posHistory[i]
		var btn uint64
		if i < len(attackHistory) {
			btn = attackHistory[i]
		}
		d := distanceBetween(s.Position, prev.Position)
		fmt.Fprintf(os.Stderr, "tick=%d pos=(%.1f,%.1f,%.1f) yaw=%.1f pitch=%.1f move=%t jump=%t step=%.2f buttons=%s\n",
			s.Tick, s.Position.X, s.Position.Y, s.Position.Z, s.Yaw, s.Pitch,
			hasMovementButton(btn), (btn&uint64(common.ButtonJump)) != 0, d, getThrowKeysFromButtons(btn))
		prev = s
	}
}

// pendingNade — внутреннее состояние одной гранаты в процессе полёта (v2).
type pendingNade struct {
	traj *models.NadeTrajectory

	throwTick   int
	startTick   int
	grenadeType string

	// projectileEntityID на момент броска
	projectileEntityID *int

	// Точная точка взрыва из explode-события движка (если получена).
	explodePos    *models.TrajectoryPoint
	explodeTick   int
	hasExplodePos bool
}

// Parse — НОВАЯ точка входа детекции гранат (v2).
// ParseDemoFileWithOptions вызывает именно её.
func (p *DemoParser) Parse() ([]*models.ParsedGrenade, error) {
	file, err := os.Open(p.filePath)
	if err != nil {
		return nil, fmt.Errorf("ошибка открытия файла %s: %w", p.filePath, err)
	}
	defer file.Close()

	parser := demoinfocs.NewParser(file)
	defer parser.Close()

	parser.RegisterNetMessageHandler(func(m *msg.CSVCMsg_ServerInfo) {
		p.mapName = utils.GetDjangoMapName(m.GetMapName())
	})

	var tickRate float64

	// uniqueID гранаты -> состояние полёта
	pending := make(map[int64]*pendingNade)

	ensureTickRate := func() {
		if tickRate == 0 {
			tickRate = parser.TickRate()
			if tickRate == 0 {
				tickRate = 64.0
			}
			p.tickRate = tickRate
		}
	}

	// --- Бросок гранаты ---
	parser.RegisterEventHandler(func(e events.GrenadeProjectileThrow) {
		if e.Projectile == nil || e.Projectile.Thrower == nil {
			return
		}
		thrower := e.Projectile.Thrower
		weapon := e.Projectile.WeaponInstance
		if weapon == nil {
			return
		}

		grenadeType := utils.GetDjangoGrenadeType(weapon.Type.String())
		if grenadeType == "decoy" {
			return
		}

		ensureTickRate()
		currentTick := parser.GameState().IngameTick()
		p.updateRoundDurationSeconds(parser)
		roundTimeSeconds := p.currentRoundTimeSeconds(currentTick)

		// История кнопок/позиций для throw description и lineup (общие helper-ы).
		attackHistory := appendCurrentButtons(p.playerAttackHistory[thrower.EntityID], thrower.ButtonsPressedState)
		posHistory := appendCurrentPosition(
			p.playerPositionHistory[thrower.EntityID],
			currentTick,
			thrower.Position(),
			float64(thrower.ViewDirectionY()),
			float64(thrower.ViewDirectionX()),
		)

		rawThrowDesc := getThrowKeys(thrower, attackHistory)
		// Броски в движении больше НЕ отбрасываются: новый алгоритм
		// (resolveGrenadeLineupV2) корректно вычисляет их точку броска. Раньше
		// shouldRejectMovingThrow выкидывал "активные" броски (большой sweep
		// прицела без паузы), из-за чего детекция и replay рассходились — replay
		// показывал бросок, а в grenade_index.json его не было. Синхронизируем с
		// replay-пайплайном (см. replay.go: тег "fail" остаётся только для
		// битых гранат weapon == nil).
		throwDesc := normalizeThrowKeys(attackHistory, posHistory, rawThrowDesc)

		debugDumpThrow(currentTick, thrower.Name, grenadeType, rawThrowDesc, throwDesc, attackHistory, posHistory)

		// Коррекция startTick для прыжковых бросков (как в legacy).
		startTick := currentTick
		if hasThrowModifier(throwDesc, "W") && hasThrowModifier(throwDesc, "JUMP") {
			startTick = currentTick - 11
		} else if hasThrowModifier(throwDesc, "JUMP") && !hasThrowModifier(throwDesc, "W") {
			startTick = currentTick - 15
		}

		startPosOverride, lineupSnapshot, lineupTick := resolveGrenadeLineupV2(attackHistory, posHistory, throwDesc, currentTick, startTick)

		playerState := getPlayerState(thrower, throwDesc, startPosOverride, lineupSnapshot)

		var throwerEntityID *int
		if pawnEntity := thrower.PlayerPawnEntity(); pawnEntity != nil {
			idx := int(pawnEntity.ID())
			throwerEntityID = &idx
		}

		var projectileEntityID *int
		if e.Projectile.Entity != nil {
			idx := int(e.Projectile.Entity.ID())
			projectileEntityID = &idx
		}

		traj := &models.NadeTrajectory{
			UniqueID:             e.Projectile.UniqueID(),
			WeaponType:           grenadeType,
			ThrowerSteamID:       int64(thrower.SteamID64),
			ThrowerName:          thrower.Name,
			ThrowerTeam:          thrower.TeamState.ClanName(),
			ThrowerEntityID:      throwerEntityID,
			Team:                 utils.GetDjangoSide(int(thrower.Team)),
			Trajectory:           make([]models.TrajectoryPoint, 0),
			TrajectoryTicks:      make([]int, 0),
			TrajectoryDense:      make([]models.TrajectoryPoint, 0),
			TrajectoryDenseTicks: make([]int, 0),
			StartTick:            startTick,
			LineupTick:           lineupTick,
			RoundTimeSeconds:     roundTimeSeconds,
			PlayerState:          playerState,
		}

		pending[traj.UniqueID] = &pendingNade{
			traj:               traj,
			throwTick:          currentTick,
			startTick:          startTick,
			grenadeType:        grenadeType,
			projectileEntityID: projectileEntityID,
		}

		// Трекер остановки смока/молотова (как в legacy) — для расчёта реального
		// airtime до приземления (EndTick смока = рассеивание дыма, а не падение).
		p.airTrackers[e.Projectile.UniqueID()] = &AirTrack{
			LastPos:   r3.Vector{},
			ThrowTick: currentTick,
		}
	})

	// --- Официальные explode-события движка: точная точка взрыва ---
	recordExplode := func(ge events.GrenadeEvent, explodeType string) {
		ensureTickRate()
		tick := parser.GameState().IngameTick()
		// Сопоставляем по GrenadeEntityID с активными гранатами.
		pn := matchPendingByEntity(pending, ge.GrenadeEntityID, explodeType, ge.Thrower)
		if pn == nil {
			return
		}
		pn.explodePos = &models.TrajectoryPoint{X: ge.Position.X, Y: ge.Position.Y, Z: ge.Position.Z}
		pn.explodeTick = tick
		pn.hasExplodePos = true
	}

	parser.RegisterEventHandler(func(e events.HeExplode) { recordExplode(e.GrenadeEvent, "HE") })
	parser.RegisterEventHandler(func(e events.FlashExplode) { recordExplode(e.GrenadeEvent, "flash") })
	parser.RegisterEventHandler(func(e events.SmokeStart) { recordExplode(e.GrenadeEvent, "smoke") })
	parser.RegisterEventHandler(func(e events.FireGrenadeStart) { recordExplode(e.GrenadeEvent, "molotov") })

	// --- Уничтожение гранаты: собираем траекторию и финализируем ---
	parser.RegisterEventHandler(func(e events.GrenadeProjectileDestroy) {
		if e.Projectile == nil {
			return
		}
		id := e.Projectile.UniqueID()
		pn, ok := pending[id]
		if !ok {
			return
		}

		for _, entry := range e.Projectile.Trajectory {
			pn.traj.Trajectory = append(pn.traj.Trajectory, models.TrajectoryPoint{
				X: entry.Position.X, Y: entry.Position.Y, Z: entry.Position.Z,
			})
			pn.traj.TrajectoryTicks = append(pn.traj.TrajectoryTicks, entry.Tick)
		}
		pn.traj.EndTick = parser.GameState().IngameTick()

		if g := p.finalizeNadeV2(pn, tickRate); g != nil {
			p.grenades = append(p.grenades, g)
		}
		delete(pending, id)
		delete(p.airTrackers, id)
	})

	// --- Запись истории позиций/кнопок игроков для lineup/throw-desc ---
	parser.RegisterEventHandler(func(e events.FrameDone) {
		tick := parser.GameState().IngameTick()
		for _, player := range parser.GameState().Participants().All() {
			if player == nil || player.Entity == nil {
				continue
			}
			history := p.playerAttackHistory[player.EntityID]
			history = append(history, player.ButtonsPressedState)
			if len(history) > attackHistorySize {
				history = history[len(history)-attackHistorySize:]
			}
			p.playerAttackHistory[player.EntityID] = history

			p.playerPositionHistory[player.EntityID] = appendCurrentPosition(
				p.playerPositionHistory[player.EntityID],
				tick,
				player.Position(),
				float64(player.ViewDirectionY()),
				float64(player.ViewDirectionX()),
			)
		}

		// Плотная траектория (опция -trajectory-dense): сэмплируем позиции
		// активных гранат на каждом кадре.
		if p.options.IncludeTrajectoryDense {
			for _, proj := range parser.GameState().GrenadeProjectiles() {
				if proj == nil {
					continue
				}
				pn, ok := pending[proj.UniqueID()]
				if !ok {
					continue
				}
				pp := proj.Position()
				point := models.TrajectoryPoint{X: pp.X, Y: pp.Y, Z: pp.Z}
				if n := len(pn.traj.TrajectoryDense); n > 0 {
					last := n - 1
					if pn.traj.TrajectoryDenseTicks[last] == tick {
						pn.traj.TrajectoryDense[last] = point
						continue
					}
					if sameTrajectoryPoint(pn.traj.TrajectoryDense[last], point) {
						continue
					}
				}
				pn.traj.TrajectoryDense = append(pn.traj.TrajectoryDense, point)
				pn.traj.TrajectoryDenseTicks = append(pn.traj.TrajectoryDenseTicks, tick)
			}
		}

		// Трекер остановки смока/молотова (как в legacy): когда снаряд перестаёт
		// двигаться, вычисляем реальный airtime (от броска до остановки) и
		// сохраняем в AirtimeOverride. Для смока это даёт время ПОЛЁТА, а не
		// время жизни дыма (EndTick).
		for _, proj := range parser.GameState().GrenadeProjectiles() {
			if proj == nil {
				continue
			}
			id := proj.UniqueID()
			at := p.airTrackers[id]
			if at == nil || at.Done {
				continue
			}
			pn, ok := pending[id]
			if !ok {
				continue
			}
			weapon := proj.WeaponInstance
			if weapon == nil {
				continue
			}
			if utils.GetDjangoGrenadeType(weapon.Type.String()) == "flash" {
				continue // флешки взрываются в воздухе, остановку не отслеживаем
			}

			pp := proj.Position()
			pos := r3.Vector{X: pp.X, Y: pp.Y, Z: pp.Z}
			dist := 0.0
			if at.LastPos != (r3.Vector{}) {
				dx := pos.X - at.LastPos.X
				dy := pos.Y - at.LastPos.Y
				dz := pos.Z - at.LastPos.Z
				dist = math.Sqrt(dx*dx + dy*dy + dz*dz)
			}
			if dist > epsDist {
				at.HasMoved = true
				at.StableTicks = 0
			} else if at.HasMoved {
				at.StableTicks++
			}
			at.LastPos = pos

			age := tick - at.ThrowTick
			if at.HasMoved && age >= minAgeTicks && at.StableTicks >= stableNeed {
				at.Done = true
				stopTick := tick - at.StableTicks
				tr := tickRate
				if tr <= 0 {
					tr = 64.0
				}
				pn.traj.AirtimeOverride = float64(stopTick-at.ThrowTick) / tr
			}
		}
	})

	parser.RegisterEventHandler(func(e events.RoundStart) {
		ensureTickRate()
		if e.TimeLimit > 0 {
			p.roundDurationSeconds = float64(e.TimeLimit)
		} else {
			p.updateRoundDurationSeconds(parser)
		}
		p.roundActionStartTick = -1
	})

	parser.RegisterEventHandler(func(e events.RoundFreezetimeEnd) {
		ensureTickRate()
		p.updateRoundDurationSeconds(parser)
		p.roundActionStartTick = parser.GameState().IngameTick()
	})

	if err := parser.ParseToEnd(); err != nil && err != demoinfocs.ErrUnexpectedEndOfDemo {
		return nil, fmt.Errorf("ошибка парсинга демо: %w", err)
	}

	// Финализируем гранаты, для которых не пришёл Destroy (конец демки и т.п.).
	for id, pn := range pending {
		if g := p.finalizeNadeV2(pn, tickRate); g != nil {
			p.grenades = append(p.grenades, g)
		}
		delete(pending, id)
	}

	ensureTickRate()
	return p.grenades, nil
}

// matchPendingByEntity ищет активную гранату по entity ID explode-события.
// Если по entity не нашлось — пробует по типу + thrower (fallback).
func matchPendingByEntity(pending map[int64]*pendingNade, entityID int, explodeType string, thrower *common.Player) *pendingNade {
	if entityID != 0 {
		for _, pn := range pending {
			if pn.projectileEntityID != nil && *pn.projectileEntityID == entityID && !pn.hasExplodePos {
				return pn
			}
		}
	}
	// Fallback: ближайшая по тику граната того же типа от того же игрока.
	var best *pendingNade
	for _, pn := range pending {
		if pn.hasExplodePos || pn.grenadeType != explodeType {
			continue
		}
		if thrower != nil && pn.traj.ThrowerSteamID != int64(thrower.SteamID64) {
			continue
		}
		if best == nil || pn.throwTick > best.throwTick {
			best = pn
		}
	}
	return best
}

// finalizeNadeV2 превращает накопленное состояние в ParsedGrenade (v2).
func (p *DemoParser) finalizeNadeV2(pn *pendingNade, tickRate float64) *models.ParsedGrenade {
	traj := pn.traj
	if traj.WeaponType == "decoy" {
		return nil
	}
	if len(traj.Trajectory) == 0 && !pn.hasExplodePos {
		return nil
	}

	if tickRate <= 0 {
		tickRate = 64.0
	}

	// Плотная траектория: упрощаем или очищаем в зависимости от опции.
	if p.options.IncludeTrajectoryDense {
		traj.TrajectoryDense, traj.TrajectoryDenseTicks = simplifyDenseTrajectory(
			traj.TrajectoryDense, traj.TrajectoryDenseTicks,
		)
	} else {
		traj.TrajectoryDense = nil
		traj.TrajectoryDenseTicks = nil
	}

	// startPos: точка lineup игрока, иначе первая точка траектории.
	var startPos models.TrajectoryPoint
	if traj.PlayerState != nil && (traj.PlayerState.Position.X != 0 || traj.PlayerState.Position.Y != 0 || traj.PlayerState.Position.Z != 0) {
		startPos = traj.PlayerState.Position
	} else if len(traj.Trajectory) > 0 {
		startPos = traj.Trajectory[0]
	}

	// endPos (точка взрыва/приземления): берём ПОСЛЕДНЮЮ точку траектории снаряда
	// для ВСЕХ типов — как в старом (legacy) алгоритме. Это надёжно и не путает
	// гранаты. Explode-события движка (HeExplode/FlashExplode/SmokeStart/
	// FireGrenadeStart) НЕ используются для позиции, т.к. их GrenadeEntityID
	// ненадёжно сопоставляется со снарядом и путает близкие по времени броски
	// одного игрока (double-flash, повторные молотовы).
	var endPos models.TrajectoryPoint
	if len(traj.Trajectory) > 0 {
		endPos = traj.Trajectory[len(traj.Trajectory)-1]
	} else if pn.hasExplodePos && pn.explodePos != nil {
		// нет траектории — единственный доступный fallback
		endPos = *pn.explodePos
	}

	// airtime: как в старом (legacy) алгоритме.
	// Если трекер остановки смока/молотова дал AirtimeOverride (реальное время
	// полёта до приземления) — используем его. Иначе (EndTick - StartTick).
	// Для HE/flash — константа 1.6, т.к. их EndTick это уничтожение entity.
	airtime := 0.0
	if traj.AirtimeOverride > 0 {
		airtime = traj.AirtimeOverride
	} else {
		ticks := traj.EndTick - traj.StartTick
		if tickRate > 0 {
			airtime = float64(ticks) / tickRate
		}
	}
	if traj.WeaponType == "HE" || traj.WeaponType == "flash" {
		airtime = 1.6
	}

	throwDescription := ""
	coordinates := ""
	if traj.PlayerState != nil {
		if len(traj.PlayerState.Buttons) > 0 {
			throwDescription = traj.PlayerState.Buttons[0]
		}
		if traj.PlayerState.Position.X != 0 || traj.PlayerState.Position.Y != 0 || traj.PlayerState.Position.Z != 0 {
			coordinates = formatCoordinates(traj.PlayerState.Position, traj.PlayerState.Pitch, traj.PlayerState.Yaw)
		}
	}

	startCopy := startPos
	endCopy := endPos

	return &models.ParsedGrenade{
		MapName:              p.mapName,
		Side:                 traj.Team,
		GrenadeType:          traj.WeaponType,
		DemoFilename:         p.fileName,
		ThrowTick:            traj.StartTick,
		LineupTick:           traj.LineupTick,
		Tickrate:             tickRate,
		RoundTimeSeconds:     traj.RoundTimeSeconds,
		ThrowerSteamID64:     traj.ThrowerSteamID,
		ThrowerEntityID:      traj.ThrowerEntityID,
		ThrowerName:          traj.ThrowerName,
		ThrowerTeam:          traj.ThrowerTeam,
		Team1:                p.team1,
		Team2:                p.team2,
		StartPos:             &startCopy,
		EndPos:               &endCopy,
		Trajectory:           traj.Trajectory,
		TrajectoryTicks:      traj.TrajectoryTicks,
		TrajectoryDense:      traj.TrajectoryDense,
		TrajectoryDenseTicks: traj.TrajectoryDenseTicks,
		ProjectileEntityID:   pn.projectileEntityID,
		Airtime:              airtime,
		ThrowKeys:            throwDescription,
		Coordinates:          coordinates,
	}
}

// moveDir возвращает набор активных кнопок направления (WASD) как битовую маску.
func moveDir(b uint64) uint64 {
	return b & (uint64(common.ButtonForward) | uint64(common.ButtonBack) |
		uint64(common.ButtonMoveLeft) | uint64(common.ButtonMoveRight))
}

// countSetMoveKeys считает сколько клавиш WASD нажато в маске направления.
func countSetMoveKeys(dir uint64) int {
	keys := []uint64{
		uint64(common.ButtonForward), uint64(common.ButtonBack),
		uint64(common.ButtonMoveLeft), uint64(common.ButtonMoveRight),
	}
	c := 0
	for _, k := range keys {
		if dir&k != 0 {
			c++
		}
	}
	return c
}

// newlyPressedMoveKey определяет, какая клавиша движения на тике finalIdx была
// нажата ПОЗЖЕ других (т.е. её не было на предыдущем тике с движением).
// Возвращает 0, если определить однозначно не удалось.
func newlyPressedMoveKey(attackHistory []uint64, finalIdx int) uint64 {
	finalDir := moveDir(attackHistory[finalIdx])
	// Ищем ближайший предыдущий тик, где было движение.
	prevIdx := finalIdx - 1
	for prevIdx >= 0 && moveDir(attackHistory[prevIdx]) == 0 {
		prevIdx--
	}
	if prevIdx < 0 {
		return 0
	}
	prevDir := moveDir(attackHistory[prevIdx])
	// Клавиши, появившиеся на finalIdx, которых не было на предыдущем тике.
	added := finalDir &^ prevDir
	if countSetMoveKeys(added) == 1 {
		return added
	}
	return 0
}

// resolveGrenadeLineupV2 — единая точка определения lineup гранаты (новый алгоритм).
// Используется и в детекции гранат (grenade_v2.go), и в реплее (replay.go),
// чтобы позиция броска считалась одинаково везде.
//
// Ветвление:
//   - бросок В ДВИЖЕНИИ (есть WASD): resolveMovingReleaseLineup — точка финального
//     захода (смена направления / фиксация прицела), без улёта на спавн;
//   - ПРЫЖКОВЫЙ бросок с места (JUMP без WASD): resolveStandingJumpLineup —
//     позиция перед отрывом от земли;
//   - СТАЦИОНАРНЫЙ бросок: прежняя логика resolveLineupStart.
func resolveGrenadeLineupV2(attackHistory []uint64, posHistory []PositionSnapshot, throwDesc string, currentTick, startTick int) (*models.TrajectoryPoint, *PositionSnapshot, *int) {
	var startPosOverride *models.TrajectoryPoint
	var lineupSnapshot *PositionSnapshot
	var lineupTick *int

	if hasAnyMovementModifier(throwDesc) {
		var snapshot *PositionSnapshot
		if hasThrowModifier(throwDesc, "W") && hasThrowModifier(throwDesc, "JUMP") {
			snapshot = resolveForwardJumpRunup(attackHistory, posHistory)
		}
		if snapshot == nil {
			snapshot = resolveMovingReleaseLineup(attackHistory, posHistory)
		}
		if hasThrowModifier(throwDesc, "JUMP") {
			snapshot = groundSnapshotBeforeJump(posHistory, snapshot)
		}
		if snapshot != nil {
			lineupSnapshot = snapshot
			lineupTick = intPtr(snapshot.Tick)
		} else if s := findSnapshotAtOrBeforeTick(posHistory, currentTick-2); s != nil {
			lineupSnapshot = s
			lineupTick = intPtr(s.Tick)
		}
	} else if hasThrowModifier(throwDesc, "JUMP") {
		snapshot := resolveStandingJumpLineup(posHistory)
		if snapshot != nil {
			lineupSnapshot = snapshot
			lineupTick = intPtr(snapshot.Tick)
		} else if s := findSnapshotAtOrBeforeTick(posHistory, currentTick-2); s != nil {
			lineupSnapshot = s
			lineupTick = intPtr(s.Tick)
		}
	} else {
		startPosOverride, lineupSnapshot, lineupTick = resolveLineupStart(attackHistory, posHistory, throwDesc, currentTick)
		startPosOverride, lineupSnapshot, lineupTick = alignJumpLineupToStartTick(
			startPosOverride, lineupSnapshot, lineupTick, posHistory, throwDesc, startTick,
		)
	}

	return startPosOverride, lineupSnapshot, lineupTick
}

// resolveForwardJumpRunup returns the first stable-aim tick of the final W
// hold that reaches a jump throw. This excludes earlier run-up ticks where
// the player was still adjusting the crosshair.
func resolveForwardJumpRunup(attackHistory []uint64, posHistory []PositionSnapshot) *PositionSnapshot {
	n := len(attackHistory)
	if len(posHistory) < n {
		n = len(posHistory)
	}
	if n == 0 {
		return nil
	}

	jumpIdx := -1
	for i := n - 1; i >= 0; i-- {
		if (attackHistory[i] & uint64(common.ButtonJump)) != 0 {
			jumpIdx = i
			break
		}
	}
	if jumpIdx < 0 {
		return nil
	}

	// Some demos release W one or more ticks before the grenade event while
	// the player is already in the jump. Use the final W tick before jumping.
	forwardIdx := jumpIdx
	for forwardIdx >= 0 && (attackHistory[forwardIdx]&uint64(common.ButtonForward)) == 0 {
		forwardIdx--
	}
	if forwardIdx < 0 {
		return nil
	}

	start := forwardIdx
	for start > 0 && (attackHistory[start-1]&uint64(common.ButtonForward)) != 0 {
		start--
	}
	// When W and JUMP begin together, there is no ground run-up to use.
	// Keep the lineup on the final ground tick instead of a later in-air
	// snapshot from the projectile event.
	if (attackHistory[start] & uint64(common.ButtonJump)) != 0 {
		return findPositionBeforeJump(posHistory, start)
	}
	aimStart := aimLockStartIndex(posHistory, forwardIdx)
	if aimStart < 0 {
		snapshot := posHistory[forwardIdx]
		return &snapshot
	}
	if aimStart > start {
		start = aimStart
	}
	snapshot := posHistory[start]
	return &snapshot
}

func findPositionBeforeJump(posHistory []PositionSnapshot, jumpIdx int) *PositionSnapshot {
	if jumpIdx <= 0 || jumpIdx >= len(posHistory) {
		return nil
	}
	snapshot := posHistory[jumpIdx-1]
	return &snapshot
}

// groundSnapshotBeforeJump corrects demos that omit ButtonJump in the player
// input stream even though the player's Z position clearly starts rising.
func groundSnapshotBeforeJump(posHistory []PositionSnapshot, snapshot *PositionSnapshot) *PositionSnapshot {
	if snapshot == nil {
		return nil
	}

	idx := -1
	for i := len(posHistory) - 1; i >= 0; i-- {
		if posHistory[i].Tick == snapshot.Tick {
			idx = i
			break
		}
	}
	if idx < 1 {
		return snapshot
	}

	// Sloped terrain can change Z by fractions of a unit per tick. A real
	// jump rises by multiple units, so ignore ordinary elevation changes.
	const jumpRisePerTick = 1.0
	groundIdx := -1
	for i := idx; i > 0 && i >= idx-32; i-- {
		if posHistory[i].Position.Z > posHistory[i-1].Position.Z+jumpRisePerTick {
			groundIdx = i - 1
		}
	}
	if groundIdx < 0 {
		return snapshot
	}

	ground := posHistory[groundIdx]
	return &ground
}

// resolveMovingReleaseLineup определяет точку lineup для броска В ДВИЖЕНИИ.
//
// Идея: реальная "точка броска" — это место, откуда игрок начал ФИНАЛЬНЫЙ заход
// к броску, а не отмотанная назад "стабильная точка до начала бега".
//
// Алгоритм (ПО СМЕНЕ НАПРАВЛЕНИЯ ДВИЖЕНИЯ):
//  1. От РЕЛИЗА (конца истории) определяем финальное направление движения —
//     набор кнопок WASD на последнем тике, где было движение (например W).
//  2. Идём назад, пока направление движения СОВПАДАЕТ с финальным
//     (игрок продолжает идти в ту же сторону к точке броска).
//  3. Останавливаемся на тике, где направление ДРУГОЕ или движение отпущено —
//     это момент, где игрок сменил поведение на финальный заход к броску
//     (конец counter-strafe / паузы / предыдущего манёвра).
//
// Это корректно обрабатывает:
//   - простой разбег (W ... W -> релиз): берём начало блока W;
//   - паузу перед броском (бег, пауза, W -> релиз): пауза != W -> стоп на паузе;
//   - counter-strafe на месте (A/D туда-сюда, потом W -> релиз): A/D != W ->
//     стоп в момент перехода на финальный W (точка топтания на месте).
//
// Возвращает снапшот позиции на тике начала финального захода.
func resolveMovingReleaseLineup(attackHistory []uint64, posHistory []PositionSnapshot) *PositionSnapshot {
	n := len(attackHistory)
	if m := len(posHistory); m < n {
		n = m
	}
	if n == 0 {
		return nil
	}

	releaseIdx := n - 1

	// (1) Последний тик с движением у релиза.
	finalIdx := releaseIdx
	for finalIdx >= 0 && moveDir(attackHistory[finalIdx]) == 0 {
		finalIdx--
	}
	if finalIdx < 0 {
		// движения нет вообще — fallback на позицию у релиза
		idx := releaseIdx
		if idx >= len(posHistory) {
			idx = len(posHistory) - 1
		}
		if idx < 0 {
			return nil
		}
		s := posHistory[idx]
		return &s
	}

	// (2) ПОСЛЕДНЯЯ НАЖАТАЯ клавиша движения перед релизом.
	//     Если на финальном тике нажато несколько (напр. W+D), берём ту,
	//     которая появилась ПОЗЖЕ (её не было на предыдущем тике движения) —
	//     это и есть "последняя нажатая клавиша до точки релиза".
	finalDir := moveDir(attackHistory[finalIdx])
	keyDir := finalDir
	if bits := countSetMoveKeys(finalDir); bits > 1 {
		if newer := newlyPressedMoveKey(attackHistory, finalIdx); newer != 0 {
			keyDir = newer
		}
	}

	// (3) Идём назад, пока игрок продолжает держать ЭТУ ЖЕ клавишу движения.
	//     Как только её не стало (другая клавиша / пауза) — финальный заход начался.
	startOfFinal := finalIdx
	for startOfFinal > 0 {
		prevDir := moveDir(attackHistory[startOfFinal-1])
		if (prevDir & keyDir) == 0 {
			break
		}
		startOfFinal--
	}
	moveChangeIdx := startOfFinal - 1
	if moveChangeIdx < 0 {
		moveChangeIdx = startOfFinal
	}

	// (4) ФИКСАЦИЯ ПРИЦЕЛА: при долгом непрерывном беге (одна клавиша зажата всю
	//     историю) точка по смене движения улетает в начало истории. Но игрок
	//     перед броском ОБЫЧНО фиксирует прицел: yaw перестаёт значимо меняться
	//     вплоть до релиза. Находим НАЧАЛО этого стабильного-yaw участка — это
	//     момент, где игрок навёлся на цель и начал финальный заход к броску.
	aimLockIdx := aimLockStartIndex(posHistory, releaseIdx)

	// Если жёсткого плато прицела нет (aimLockStartIndex вернул -1), значит игрок
	// микро-доворачивал мышью вплоть до самого релиза — надёжной "точки финального
	// захода" в истории нет. В этом случае НЕ откатываемся к moveChangeIdx (он при
	// долгом беге улетает в начало истории/на спавн), а берём позицию НА МОМЕНТ
	// БРОСКА (релиз) — это setpos/setang самого события броска из парсера.
	if aimLockIdx < 0 {
		snapshot := posHistory[releaseIdx]
		return &snapshot
	}

	// Берём ПОЗДНЕЙШУЮ (ближе к броску) из двух точек — она надёжнее отражает
	// начало финального стабильного участка прицела и не улетает на ранний
	// участок движения, где игрок ещё доворачивал мышь.
	chosenIdx := moveChangeIdx
	if aimLockIdx > chosenIdx {
		chosenIdx = aimLockIdx
	}

	if chosenIdx >= len(posHistory) {
		chosenIdx = len(posHistory) - 1
	}
	if chosenIdx < 0 {
		return nil
	}

	snapshot := posHistory[chosenIdx]
	return &snapshot
}

// aimLockStartIndex находит начало финального участка, где прицел зафиксирован
// (игрок навёлся на цель и держит прицел до релиза). Идёт от релиза назад,
// пока yaw ИЛИ pitch не отклоняются от значения на релизе больше порога.
// Прицел = и горизонталь (yaw), и вертикаль (pitch): доворот по pitch (навесные
// броски) тоже означает, что финальный заход ещё не наступил.
// Возвращает индекс начала стабильного-прицела участка, или -1 если участок короткий.
func aimLockStartIndex(posHistory []PositionSnapshot, releaseIdx int) int {
	if releaseIdx < 0 || releaseIdx >= len(posHistory) {
		return -1
	}
	const yawLockEps = 0.3   // жёсткий порог: yaw зафиксирован при отклонении <0.3° (только реальное плато, не доворот)
	const pitchLockEps = 0.3 // тот же порог для вертикали: pitch не должен доворачиваться
	const minLockTicks = 5   // минимальная длина участка фиксации, чтобы ему доверять

	releaseYaw := posHistory[releaseIdx].Yaw
	releasePitch := posHistory[releaseIdx].Pitch
	i := releaseIdx
	for i > 0 {
		if math.Abs(angleDeltaDegrees(posHistory[i-1].Yaw, releaseYaw)) > yawLockEps {
			break
		}
		if math.Abs(angleDeltaDegrees(posHistory[i-1].Pitch, releasePitch)) > pitchLockEps {
			break
		}
		i--
	}
	if releaseIdx-i < minLockTicks {
		return -1
	}
	return i
}

// resolveStandingJumpLineup определяет точку lineup для ПРЫЖКОВОГО броска С МЕСТА
// (JUMP без кнопок движения).
//
// Игрок стоит на месте (X,Y почти не меняются), затем подпрыгивает (Z растёт)
// и бросает гранату в воздухе. Нужная точка — позиция НЕПОСРЕДСТВЕННО ПЕРЕД
// ОТРЫВОМ от земли.
//
// Идём от релиза назад и ищем последний тик "на земле" перед взлётом:
// тик, после которого Z начал расти (отрыв), при этом X,Y стабильны.
func resolveStandingJumpLineup(posHistory []PositionSnapshot) *PositionSnapshot {
	n := len(posHistory)
	if n == 0 {
		return nil
	}

	const xyStableEps = 8.0     // насколько X,Y могут гулять, чтобы считать "стоит на месте"
	const zStableEps = 0.5      // порог изменения Z за тик, ниже которого Z "не меняется"
	const groundStableTicks = 3 // сколько тиков подряд Z должен быть стабилен = земля

	releaseIdx := n - 1

	xyStable := func(a, b PositionSnapshot) bool {
		dx := a.Position.X - b.Position.X
		dy := a.Position.Y - b.Position.Y
		return math.Abs(dx) <= xyStableEps && math.Abs(dy) <= xyStableEps
	}

	// Идём от релиза назад через фазу полёта (Z меняется при стабильных X,Y)
	// и ищем НАСТОЯЩУЮ землю перед прыжком: тик, где Z стабилен на протяжении
	// groundStableTicks тиков подряд. Это исключает ложное срабатывание из-за
	// дубля последнего тика (FrameDone пишет релиз дважды с тем же Z) и из-за
	// апекса прыжка (где dz≈0 на один тик).
	//
	// ВАЖНО: берём момент отрыва (последний тик на земле), НЕ спускаемся к началу
	// долгого стояния, иначе при засаде на месте улетим далеко назад.
	isGround := func(idx int) bool {
		// Z стабилен на groundStableTicks тиков назад при стабильных X,Y.
		for k := 0; k < groundStableTicks; k++ {
			a := idx - k
			b := idx - k - 1
			if b < 0 {
				return false
			}
			if !xyStable(posHistory[a], posHistory[b]) {
				return false
			}
			if math.Abs(posHistory[a].Position.Z-posHistory[b].Position.Z) > zStableEps {
				return false
			}
		}
		return true
	}

	i := releaseIdx
	for i > 0 {
		if !xyStable(posHistory[i], posHistory[i-1]) {
			// игрок сместился по X,Y — это уже не "прыжок с места", выходим
			break
		}
		if isGround(i) {
			// нашли устойчивую землю перед отрывом
			break
		}
		i--
	}

	if i < 0 {
		i = 0
	}
	if i >= n {
		i = n - 1
	}
	s := posHistory[i]
	return &s
}

// getThrowKeysFromButtons декодирует одну маску кнопок в читаемую строку (отладка).
func getThrowKeysFromButtons(b uint64) string {
	parts := make([]string, 0, 8)
	if (b & uint64(common.ButtonAttack)) != 0 {
		parts = append(parts, "LMB")
	}
	if (b & uint64(common.ButtonAttack2)) != 0 {
		parts = append(parts, "RMB")
	}
	if (b & uint64(common.ButtonForward)) != 0 {
		parts = append(parts, "W")
	}
	if (b & uint64(common.ButtonMoveLeft)) != 0 {
		parts = append(parts, "A")
	}
	if (b & uint64(common.ButtonBack)) != 0 {
		parts = append(parts, "S")
	}
	if (b & uint64(common.ButtonMoveRight)) != 0 {
		parts = append(parts, "D")
	}
	if (b & uint64(common.ButtonJump)) != 0 {
		parts = append(parts, "JUMP")
	}
	if (b & uint64(common.ButtonDuck)) != 0 {
		parts = append(parts, "DUCK")
	}
	if (b & uint64(common.ButtonSpeed)) != 0 {
		parts = append(parts, "SHIFT")
	}
	if len(parts) == 0 {
		return "-"
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += "+" + p
	}
	return out
}
