package parser

import (
	"fmt"
	"math"
	"nadesoulpars/pkg/models"
	"os"
	"path/filepath"
	"strings"

	"github.com/golang/geo/r3"
	demoinfocs "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/common"
)

// DemoParser представляет парсер для одного демофайла
type DemoParser struct {
	filePath             string
	fileName             string
	options              OutputOptions
	grenades             []*models.ParsedGrenade
	currentRound         int
	tickRate             float64
	mapName              string
	team1                string
	team2                string
	roundActionStartTick int
	roundDurationSeconds float64

	// Для отслеживания остановки смоков
	airTrackers map[int64]*AirTrack

	// Для отслеживания кнопок атаки (LMB/RMB) - история за 128 тиков
	playerAttackHistory map[int][]uint64 // UserID -> история кнопок

	// Для отслеживания позиций игроков - история за 128 тиков
	playerPositionHistory map[int][]PositionSnapshot // UserID -> история позиций
}

type OutputOptions struct {
	IncludeTrajectoryDense    bool
	IncludeThrowerSteamID64   bool
	IncludeThrowerAccountID   bool
	IncludeThrowerEntityID    bool
	IncludeProjectileEntityID bool
}

func DefaultOutputOptions() OutputOptions {
	return OutputOptions{
		IncludeTrajectoryDense:    false,
		IncludeThrowerSteamID64:   true,
		IncludeThrowerAccountID:   true,
		IncludeThrowerEntityID:    true,
		IncludeProjectileEntityID: true,
	}
}

// История кнопок за 700 тиков (~11 секунд), чтобы захватывать длинное движение до броска.
const attackHistorySize = 700

// AirTrack отслеживает движение гранаты для определения остановки
type AirTrack struct {
	LastPos     r3.Vector
	StableTicks int
	Done        bool
	HasMoved    bool
	ThrowTick   int
}

type PositionSnapshot struct {
	Tick     int
	Position r3.Vector
	Pitch    float64
	Yaw      float64
}

type LineupOrigin struct {
	Position models.TrajectoryPoint
	Tick     int
}

// Константы для определения остановки
const (
	minAgeTicks = 32
	stableNeed  = 32
	epsDist     = 0.5

	denseDuplicateDistanceEps = 0.01
	denseSimplifyEpsilon      = 0.25
	denseSimplifyMaxTickGap   = 8
	duckRecentWindowTicks     = 5
)

// NewDemoParser создаёт новый парсер для демофайла
func NewDemoParser(filePath string) *DemoParser {
	return NewDemoParserWithOptions(filePath, DefaultOutputOptions())
}

func NewDemoParserWithOptions(filePath string, options OutputOptions) *DemoParser {
	return &DemoParser{
		filePath:              filePath,
		fileName:              filepath.Base(filePath),
		options:               options,
		grenades:              make([]*models.ParsedGrenade, 0),
		airTrackers:           make(map[int64]*AirTrack),
		playerAttackHistory:   make(map[int][]uint64),
		playerPositionHistory: make(map[int][]PositionSnapshot),
		roundActionStartTick:  -1,
	}
}

// getThrowKeys формирует строку кнопок броска.
func getThrowKeys(player *common.Player, attackHistory []uint64) string {
	var parts []string

	// Анализируем историю кнопок за последние 20 тиков
	// Ищем нажатия LMB и RMB
	var lmbPressed, rmbPressed bool
	checkRecentTicks := 20
	startIdx := len(attackHistory) - checkRecentTicks
	if startIdx < 0 {
		startIdx = 0
	}
	for i := startIdx; i < len(attackHistory); i++ {
		buttons := attackHistory[i]
		if (buttons & uint64(common.ButtonAttack)) != 0 {
			lmbPressed = true
		}
		if (buttons & uint64(common.ButtonAttack2)) != 0 {
			rmbPressed = true
		}
	}

	// Определяем тип броска по истории нажатий
	if lmbPressed && rmbPressed {
		parts = append(parts, "LMB+RMB") // Средний бросок
	} else if lmbPressed {
		parts = append(parts, "LMB") // Дальний бросок
	} else if rmbPressed {
		parts = append(parts, "RMB") // Короткий бросок
	} else {
		// По умолчанию LMB
		parts = append(parts, "LMB")
	}

	// Для обычных бросков считаем движением только непрерывный хвост кнопок у самого релиза.
	// Для jump-throw ищем движение только до прыжка, чтобы пост-прыжковые коррекции
	// вроде короткого нажатия S не ломали реальный lineup разбега.
	var lastMoveButton string

	checkRecentTicks = 20
	startIdx = len(attackHistory) - checkRecentTicks
	if startIdx < 0 {
		startIdx = 0
	}

	moveSearchStart := startIdx
	moveSearchEnd := len(attackHistory) - 1
	lastJumpIdx := -1
	for i := len(attackHistory) - 1; i >= startIdx; i-- {
		if (attackHistory[i] & uint64(common.ButtonJump)) != 0 {
			lastJumpIdx = i
			moveSearchEnd = i
			break
		}
	}

	if lastJumpIdx == -1 {
		// Ищем ЛЮБОЕ движение в последних 20 тиках, а не только непрерывный хвост
		// Это нужно для случаев, когда W был отпущен за несколько тиков до броска
		for i := len(attackHistory) - 1; i >= startIdx; i-- {
			if hasMovementButton(attackHistory[i]) {
				moveSearchStart = i
				moveSearchEnd = i
				break
			}
		}
	}

	for i := moveSearchEnd; i >= moveSearchStart; i-- {
		buttons := attackHistory[i]

		// Проверяем в порядке приоритета: W > A > S > D
		if (buttons & uint64(common.ButtonForward)) != 0 {
			lastMoveButton = "W"
			break
		}
		if (buttons & uint64(common.ButtonMoveLeft)) != 0 {
			lastMoveButton = "A"
			break
		}
		if (buttons & uint64(common.ButtonBack)) != 0 {
			lastMoveButton = "S"
			break
		}
		if (buttons & uint64(common.ButtonMoveRight)) != 0 {
			lastMoveButton = "D"
			break
		}
	}

	if lastMoveButton != "" {
		parts = append(parts, lastMoveButton)
	}

	// Проверяем прыжок
	if player.IsPressingButton(common.ButtonJump) || player.IsAirborne() {
		parts = append(parts, "JUMP")
	}

	// Проверяем приседание только в узком окне у самого действия.
	// Ранний duck во время наведения не должен попадать в описание броска.
	var duckPressed bool
	duckCheckEnd := len(attackHistory) - 1
	if lastJumpIdx != -1 {
		duckCheckEnd = lastJumpIdx
	}
	duckCheckStart := duckCheckEnd - duckRecentWindowTicks + 1
	if duckCheckStart < startIdx {
		duckCheckStart = startIdx
	}
	if duckCheckStart < 0 {
		duckCheckStart = 0
	}
	for i := duckCheckStart; i <= duckCheckEnd && i < len(attackHistory); i++ {
		buttons := attackHistory[i]
		if (buttons & uint64(common.ButtonDuck)) != 0 {
			duckPressed = true
			break
		}
	}
	if duckPressed {
		parts = append(parts, "DUCK")
	}

	// Проверяем SHIFT по истории (только последние 20 тиков как для WASD)
	var shiftPressed bool
	shiftCheckStart := moveSearchStart
	if shiftCheckStart < startIdx {
		shiftCheckStart = startIdx
	}
	for i := shiftCheckStart; i <= moveSearchEnd && i < len(attackHistory); i++ {
		buttons := attackHistory[i]
		if (buttons & uint64(common.ButtonSpeed)) != 0 {
			shiftPressed = true
			break
		}
	}
	// Добавляем SHIFT только если была кнопка движения
	if shiftPressed && lastMoveButton != "" {
		parts = append(parts, "SHIFT")
	}

	return strings.Join(parts, "+")
}

func hasMovementButton(buttons uint64) bool {
	return (buttons&uint64(common.ButtonForward)) != 0 ||
		(buttons&uint64(common.ButtonMoveLeft)) != 0 ||
		(buttons&uint64(common.ButtonBack)) != 0 ||
		(buttons&uint64(common.ButtonMoveRight)) != 0
}

func angleDeltaDegrees(a float64, b float64) float64 {
	delta := math.Mod(b-a+180.0, 360.0)
	if delta < 0 {
		delta += 360.0
	}
	return delta - 180.0
}

func stripMovementModifiers(throwDesc string) string {
	if throwDesc == "" {
		return ""
	}

	parts := strings.Split(throwDesc, "+")
	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "W", "A", "S", "D":
			continue
		default:
			filtered = append(filtered, part)
		}
	}

	return strings.Join(filtered, "+")
}

func appendCurrentButtons(history []uint64, current uint64) []uint64 {
	if len(history) >= attackHistorySize {
		history = history[len(history)-attackHistorySize+1:]
	}
	out := make([]uint64, len(history)+1)
	copy(out, history)
	out[len(history)] = current
	return out
}

func appendCurrentPosition(history []PositionSnapshot, tick int, current r3.Vector, pitch float64, yaw float64) []PositionSnapshot {
	if len(history) >= attackHistorySize {
		history = history[len(history)-attackHistorySize+1:]
	}
	out := make([]PositionSnapshot, len(history)+1)
	copy(out, history)
	out[len(history)] = PositionSnapshot{
		Tick:     tick,
		Position: current,
		Pitch:    pitch,
		Yaw:      yaw,
	}
	return out
}

func intPtr(value int) *int {
	return &value
}

func distanceBetween(a, b r3.Vector) float64 {
	dx := a.X - b.X
	dy := a.Y - b.Y
	dz := a.Z - b.Z
	return math.Sqrt(dx*dx + dy*dy + dz*dz)
}

func trajectoryPointDistance(a, b models.TrajectoryPoint) float64 {
	dx := a.X - b.X
	dy := a.Y - b.Y
	dz := a.Z - b.Z
	return math.Sqrt(dx*dx + dy*dy + dz*dz)
}

func sameTrajectoryPoint(a, b models.TrajectoryPoint) bool {
	return trajectoryPointDistance(a, b) <= denseDuplicateDistanceEps
}

func pointToSegmentDistance(p, a, b models.TrajectoryPoint) float64 {
	abx := b.X - a.X
	aby := b.Y - a.Y
	abz := b.Z - a.Z
	apx := p.X - a.X
	apy := p.Y - a.Y
	apz := p.Z - a.Z

	abLenSq := abx*abx + aby*aby + abz*abz
	if abLenSq <= 1e-12 {
		return trajectoryPointDistance(p, a)
	}

	t := (apx*abx + apy*aby + apz*abz) / abLenSq
	if t < 0 {
		t = 0
	} else if t > 1 {
		t = 1
	}

	closest := models.TrajectoryPoint{
		X: a.X + abx*t,
		Y: a.Y + aby*t,
		Z: a.Z + abz*t,
	}
	return trajectoryPointDistance(p, closest)
}

func simplifyDenseKeepIndices(points []models.TrajectoryPoint, epsilon float64) []int {
	if len(points) <= 2 {
		indices := make([]int, len(points))
		for i := range points {
			indices[i] = i
		}
		return indices
	}

	keep := map[int]struct{}{
		0:               {},
		len(points) - 1: {},
	}
	stack := [][2]int{{0, len(points) - 1}}

	for len(stack) > 0 {
		last := len(stack) - 1
		segment := stack[last]
		stack = stack[:last]

		start, end := segment[0], segment[1]
		bestIdx := -1
		bestDist := -1.0

		for i := start + 1; i < end; i++ {
			dist := pointToSegmentDistance(points[i], points[start], points[end])
			if dist > bestDist {
				bestDist = dist
				bestIdx = i
			}
		}

		if bestIdx != -1 && bestDist > epsilon {
			keep[bestIdx] = struct{}{}
			stack = append(stack, [2]int{start, bestIdx}, [2]int{bestIdx, end})
		}
	}

	indices := make([]int, 0, len(keep))
	for idx := range keep {
		indices = append(indices, idx)
	}

	for i := 0; i < len(indices)-1; i++ {
		for j := i + 1; j < len(indices); j++ {
			if indices[j] < indices[i] {
				indices[i], indices[j] = indices[j], indices[i]
			}
		}
	}

	return indices
}

func enforceDenseMaxTickGap(indices []int, ticks []int, maxTickGap int) []int {
	if len(indices) <= 1 || maxTickGap <= 0 {
		return indices
	}

	out := make([]int, 0, len(indices))
	out = append(out, indices[0])

	for _, idx := range indices[1:] {
		for j := out[len(out)-1] + 1; j < idx; j++ {
			if ticks[j]-ticks[out[len(out)-1]] >= maxTickGap {
				out = append(out, j)
			}
		}
		if idx != out[len(out)-1] {
			out = append(out, idx)
		}
	}

	return out
}

func simplifyDenseTrajectory(points []models.TrajectoryPoint, ticks []int) ([]models.TrajectoryPoint, []int) {
	if len(points) == 0 || len(points) != len(ticks) {
		return points, ticks
	}

	collapsedPoints := make([]models.TrajectoryPoint, 0, len(points))
	collapsedTicks := make([]int, 0, len(ticks))

	for i, point := range points {
		tick := ticks[i]
		if len(collapsedPoints) == 0 {
			collapsedPoints = append(collapsedPoints, point)
			collapsedTicks = append(collapsedTicks, tick)
			continue
		}

		last := len(collapsedPoints) - 1
		if collapsedTicks[last] == tick {
			collapsedPoints[last] = point
			continue
		}

		if sameTrajectoryPoint(collapsedPoints[last], point) {
			continue
		}

		collapsedPoints = append(collapsedPoints, point)
		collapsedTicks = append(collapsedTicks, tick)
	}

	if len(collapsedPoints) <= 2 {
		return collapsedPoints, collapsedTicks
	}

	keep := simplifyDenseKeepIndices(collapsedPoints, denseSimplifyEpsilon)
	keep = enforceDenseMaxTickGap(keep, collapsedTicks, denseSimplifyMaxTickGap)

	outPoints := make([]models.TrajectoryPoint, 0, len(keep))
	outTicks := make([]int, 0, len(keep))
	for _, idx := range keep {
		outPoints = append(outPoints, collapsedPoints[idx])
		outTicks = append(outTicks, collapsedTicks[idx])
	}

	return outPoints, outTicks
}

func (p *DemoParser) updateRoundDurationSeconds(parser demoinfocs.Parser) {
	if p.roundDurationSeconds > 0 {
		return
	}

	if parser == nil {
		return
	}

	rules := parser.GameState().Rules()
	if rules == nil {
		return
	}

	if roundTime, err := rules.RoundTime(); err == nil && roundTime > 0 {
		p.roundDurationSeconds = roundTime.Seconds()
	}
}

func (p *DemoParser) currentRoundTimeSeconds(currentTick int) *float64 {
	if p.roundActionStartTick < 0 || p.tickRate <= 0 || p.roundDurationSeconds <= 0 {
		return nil
	}

	elapsedSeconds := float64(currentTick-p.roundActionStartTick) / p.tickRate
	remainingSeconds := p.roundDurationSeconds - elapsedSeconds
	if remainingSeconds < 0 {
		remainingSeconds = 0
	}

	value := remainingSeconds
	return &value
}

func hasThrowModifier(throwDesc string, modifier string) bool {
	for _, part := range strings.Split(throwDesc, "+") {
		if part == modifier {
			return true
		}
	}
	return false
}

func findStablePosIndexBeforeIndex(posHistory []PositionSnapshot, idx int) int {
	if len(posHistory) == 0 {
		return -1
	}

	if idx <= 0 {
		return -1
	}

	if idx >= len(posHistory) {
		idx = len(posHistory) - 1
	}

	const (
		playerStopEps     = 0.1
		stableTicksBefore = 3
	)

	for i := idx; i >= stableTicksBefore; i-- {
		stable := true
		for j := 0; j < stableTicksBefore; j++ {
			if distanceBetween(posHistory[i-j].Position, posHistory[i-j-1].Position) > playerStopEps {
				stable = false
				break
			}
		}
		if stable {
			return i
		}
	}

	return -1
}

func findStablePosBeforeIndex(posHistory []PositionSnapshot, idx int) *LineupOrigin {
	stableIdx := findStablePosIndexBeforeIndex(posHistory, idx)
	if stableIdx == -1 {
		return nil
	}

	pos := posHistory[stableIdx]
	return &LineupOrigin{
		Position: models.TrajectoryPoint{
			X: pos.Position.X,
			Y: pos.Position.Y,
			Z: pos.Position.Z,
		},
		Tick: pos.Tick,
	}
}

func findStablePosInRange(posHistory []PositionSnapshot, startIdx int, endIdx int) *LineupOrigin {
	if len(posHistory) == 0 || endIdx <= 0 {
		return nil
	}

	if startIdx < 0 {
		startIdx = 0
	}

	if endIdx >= len(posHistory) {
		endIdx = len(posHistory) - 1
	}

	if startIdx > endIdx {
		return nil
	}

	const stableTicksBefore = 3
	if endIdx < stableTicksBefore {
		return nil
	}

	if startIdx < stableTicksBefore {
		startIdx = stableTicksBefore
	}

	for i := endIdx; i >= startIdx; i-- {
		stable := true
		for j := 0; j < stableTicksBefore; j++ {
			if distanceBetween(posHistory[i-j].Position, posHistory[i-j-1].Position) > 0.1 {
				stable = false
				break
			}
		}
		if stable {
			pos := posHistory[i]
			return &LineupOrigin{
				Position: models.TrajectoryPoint{
					X: pos.Position.X,
					Y: pos.Position.Y,
					Z: pos.Position.Z,
				},
				Tick: pos.Tick,
			}
		}
	}

	return nil
}

func findMovementSegmentBeforeAction(attackHistory []uint64, endIdx int) (int, int, bool) {
	if len(attackHistory) == 0 {
		return 0, 0, false
	}

	if endIdx >= len(attackHistory) {
		endIdx = len(attackHistory) - 1
	}

	for endIdx >= 0 && !hasMovementButton(attackHistory[endIdx]) {
		endIdx--
	}
	if endIdx < 0 {
		return 0, 0, false
	}

	startIdx := endIdx
	for startIdx > 0 && hasMovementButton(attackHistory[startIdx-1]) {
		startIdx--
	}

	return startIdx, endIdx, true
}

func resolveActionIndex(attackHistory []uint64, throwDesc string) int {
	n := len(attackHistory)
	if n == 0 {
		return -1
	}

	actionIdx := n - 2
	if actionIdx < 0 {
		actionIdx = n - 1
	}

	if !hasThrowModifier(throwDesc, "JUMP") {
		return actionIdx
	}

	lastJumpIdx := -1
	for i := n - 1; i >= 0; i-- {
		if (attackHistory[i] & uint64(common.ButtonJump)) != 0 {
			lastJumpIdx = i
			break
		}
	}
	if lastJumpIdx == -1 {
		return -1
	}

	return lastJumpIdx - 1
}

func movementPauseBeforeAction(attackHistory []uint64, posHistory []PositionSnapshot, throwDesc string) bool {
	n := len(posHistory)
	if len(attackHistory) < n {
		n = len(attackHistory)
	}
	if n == 0 {
		return false
	}

	actionIdx := resolveActionIndex(attackHistory[:n], throwDesc)
	if actionIdx <= 0 {
		return false
	}

	_, moveEndIdx, ok := findMovementSegmentBeforeAction(attackHistory[:n], actionIdx)
	if !ok {
		return false
	}

	if moveEndIdx >= actionIdx {
		return false
	}

	pauseStartIdx := moveEndIdx + 1
	if pauseStartIdx > actionIdx {
		return false
	}

	return findStablePosInRange(posHistory[:n], pauseStartIdx, actionIdx) != nil
}

// findStartPosBeforeMovement ищет последнюю стабильную позицию перед началом движения к броску.
func findStartPosBeforeMovement(attackHistory []uint64, posHistory []PositionSnapshot) *LineupOrigin {
	n := len(posHistory)
	if len(attackHistory) < n {
		n = len(attackHistory)
	}
	if n == 0 {
		return nil
	}

	lastMoveIdx := -1
	for i := n - 1; i >= 0; i-- {
		if hasMovementButton(attackHistory[i]) {
			lastMoveIdx = i
			break
		}
	}

	if lastMoveIdx == -1 {
		return nil
	}

	moveStartIdx := lastMoveIdx
	for moveStartIdx > 0 && hasMovementButton(attackHistory[moveStartIdx-1]) {
		moveStartIdx--
	}

	return findStablePosBeforeIndex(posHistory[:n], moveStartIdx-1)
}

// findStartPosBeforeJumpWithoutMovement ищет последнюю стабильную позицию перед прыжком,
// если бросок выполнен в прыжке без движения WASD.
func findStartPosBeforeJumpWithoutMovement(attackHistory []uint64, posHistory []PositionSnapshot) *LineupOrigin {
	n := len(posHistory)
	if len(attackHistory) < n {
		n = len(attackHistory)
	}
	if n == 0 {
		return nil
	}

	lastJumpIdx := -1
	for i := n - 1; i >= 0; i-- {
		if (attackHistory[i] & uint64(common.ButtonJump)) != 0 {
			lastJumpIdx = i
			break
		}
	}

	if lastJumpIdx == -1 {
		return nil
	}

	jumpStartIdx := lastJumpIdx
	for jumpStartIdx > 0 && (attackHistory[jumpStartIdx-1]&uint64(common.ButtonJump)) != 0 {
		jumpStartIdx--
	}

	return findStablePosBeforeIndex(posHistory[:n], jumpStartIdx-1)
}

func shouldStripMovementModifier(attackHistory []uint64, posHistory []PositionSnapshot, throwDesc string) bool {
	if !hasAnyMovementModifier(throwDesc) {
		return false
	}

	return movementPauseBeforeAction(attackHistory, posHistory, throwDesc)
}

func normalizeThrowKeys(attackHistory []uint64, posHistory []PositionSnapshot, throwDesc string) string {
	if !shouldStripMovementModifier(attackHistory, posHistory, throwDesc) {
		return throwDesc
	}

	return stripMovementModifiers(throwDesc)
}

func hasAnyMovementModifier(throwDesc string) bool {
	return hasThrowModifier(throwDesc, "W") ||
		hasThrowModifier(throwDesc, "A") ||
		hasThrowModifier(throwDesc, "S") ||
		hasThrowModifier(throwDesc, "D")
}

func findSnapshotAtOrBeforeTick(posHistory []PositionSnapshot, targetTick int) *PositionSnapshot {
	for i := len(posHistory) - 1; i >= 0; i-- {
		if posHistory[i].Tick > targetTick {
			continue
		}

		snapshot := posHistory[i]
		return &snapshot
	}

	return nil
}

func resolveLineupStart(attackHistory []uint64, posHistory []PositionSnapshot, throwDesc string, currentTick int) (*models.TrajectoryPoint, *PositionSnapshot, *int) {
	lineupTick := intPtr(currentTick)

	var origin *LineupOrigin
	if hasAnyMovementModifier(throwDesc) {
		origin = findStartPosBeforeMovement(attackHistory, posHistory)
	} else if hasThrowModifier(throwDesc, "JUMP") {
		origin = findStartPosBeforeJumpWithoutMovement(attackHistory, posHistory)
	} else {
		// Для обычного throw без override берем setpos и setang с небольшим упреждением
		// относительно тика броска, чтобы команда координат попадала в реальный lineup.
		snapshot := findSnapshotAtOrBeforeTick(posHistory, currentTick-2)
		if snapshot != nil {
			return nil, snapshot, intPtr(snapshot.Tick)
		}
	}

	if origin == nil {
		return nil, nil, lineupTick
	}

	position := origin.Position
	return &position, nil, intPtr(origin.Tick)
}

// formatCoordinates формирует консольную команду для установки позиции
func alignJumpLineupToStartTick(
	startPosOverride *models.TrajectoryPoint,
	lineupSnapshot *PositionSnapshot,
	lineupTick *int,
	posHistory []PositionSnapshot,
	throwDesc string,
	startTick int,
) (*models.TrajectoryPoint, *PositionSnapshot, *int) {
	if !hasThrowModifier(throwDesc, "JUMP") {
		return startPosOverride, lineupSnapshot, lineupTick
	}

	// Only rewrite jump lineup to startTick when the parser fell back to
	// event-state coordinates. If we already found a movement/jump origin,
	// keep that origin so real moving throws preserve their lineup tick.
	if startPosOverride != nil || lineupSnapshot != nil {
		return startPosOverride, lineupSnapshot, lineupTick
	}

	lineupTick = intPtr(startTick)
	if snapshot := findSnapshotAtOrBeforeTick(posHistory, startTick); snapshot != nil {
		return nil, snapshot, lineupTick
	}

	return startPosOverride, lineupSnapshot, lineupTick
}

func formatCoordinates(pos models.TrajectoryPoint, pitch, yaw float64) string {
	return fmt.Sprintf("setpos %.6f %.6f %.6f; setang %.6f %.6f;", pos.X, pos.Y, pos.Z, pitch, yaw)
}

// getPlayerState получает состояние игрока в момент броска
func getPlayerState(player *common.Player, throwDesc string, startPosOverride *models.TrajectoryPoint, lineupSnapshot *PositionSnapshot) *models.PlayerState {
	if player == nil {
		return nil
	}

	var pos r3.Vector
	var eyeAngle float64
	var pitch float64

	if startPosOverride != nil {
		// Для movement/jump override сохраняем setpos из найденной позиции,
		// а setang оставляем по текущему взгляду игрока в тик броска.
		pos = r3.Vector{
			X: startPosOverride.X,
			Y: startPosOverride.Y,
			Z: startPosOverride.Z,
		}
		eyeAngle = float64(player.ViewDirectionX())
		pitch = float64(player.ViewDirectionY())
	} else if lineupSnapshot != nil {
		pos = lineupSnapshot.Position
		eyeAngle = lineupSnapshot.Yaw
		pitch = lineupSnapshot.Pitch
	} else {
		pos = player.Position()
		eyeAngle = float64(player.ViewDirectionX())
		pitch = float64(player.ViewDirectionY())
	}

	return &models.PlayerState{
		Position: models.TrajectoryPoint{
			X: pos.X,
			Y: pos.Y,
			Z: pos.Z,
		},
		Pitch:   pitch,
		Yaw:     eyeAngle,
		Buttons: []string{throwDesc}, // Сохраняем описание броска
	}
}

// ParseDemoFile анализирует один демофайл и возвращает данные о гранатах
func ParseDemoFile(filePath string) ([]*models.ParsedGrenade, error) {
	return ParseDemoFileWithOptions(filePath, DefaultOutputOptions())
}

func ParseDemoFileWithOptions(filePath string, options OutputOptions) ([]*models.ParsedGrenade, error) {
	parser := NewDemoParserWithOptions(filePath, options)
	return parser.Parse()
}

// ParseDemoDirectory анализирует все демофайлы в директории
func ParseDemoDirectory(dirPath string) ([]*models.ParsedGrenade, error) {
	return ParseDemoDirectoryWithOptions(dirPath, DefaultOutputOptions())
}

func ParseDemoDirectoryWithOptions(dirPath string, options OutputOptions) ([]*models.ParsedGrenade, error) {
	var allGrenades []*models.ParsedGrenade

	err := filepath.Walk(dirPath, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Пропускаем директории
		if info.IsDir() {
			return nil
		}

		// Обрабатываем только .dem файлы
		if !strings.HasSuffix(strings.ToLower(info.Name()), ".dem") {
			return nil
		}

		fmt.Printf("Парсинг файла: %s\n", path)

		grenades, err := ParseDemoFileWithOptions(path, options)
		if err != nil {
			fmt.Printf("Ошибка парсинга %s: %v\n", path, err)
			return nil // Продолжаем парсинг остальных файлов
		}

		allGrenades = append(allGrenades, grenades...)
		fmt.Printf("Найдено гранат: %d (всего: %d)\n", len(grenades), len(allGrenades))

		return nil
	})

	if err != nil {
		return nil, fmt.Errorf("ошибка сканирования директории: %w", err)
	}

	return allGrenades, nil
}

// ConvertToGrenadeData конвертирует ParsedGrenade в GrenadeData для API
func ConvertToGrenadeData(parsed *models.ParsedGrenade) models.GrenadeData {
	return ConvertToGrenadeDataWithOptions(parsed, DefaultOutputOptions())
}

func ConvertToGrenadeDataWithOptions(parsed *models.ParsedGrenade, options OutputOptions) models.GrenadeData {
	data := models.GrenadeData{
		Map:              parsed.MapName,
		Side:             parsed.Side,
		GrenadeType:      parsed.GrenadeType,
		DemoFilename:     parsed.DemoFilename,
		ThrowTick:        parsed.ThrowTick,
		LineupTick:       parsed.LineupTick,
		Tickrate:         parsed.Tickrate,
		RoundTimeSeconds: parsed.RoundTimeSeconds,
		Thrower:          parsed.ThrowerName,
		ThrowerTeam:      parsed.ThrowerTeam,
		Team1:            parsed.Team1,
		Team2:            parsed.Team2,
		Airtime:          parsed.Airtime,
		IsManual:         false,
		ThrowKeys:        parsed.ThrowKeys,
		Coordinates:      parsed.Coordinates,
	}

	// Координаты начала
	if parsed.StartPos != nil {
		data.StartPosX = parsed.StartPos.X
		data.StartPosY = parsed.StartPos.Y
		data.StartPosZ = parsed.StartPos.Z
	}

	// Координаты конца
	if parsed.EndPos != nil {
		data.ExplodePosX = parsed.EndPos.X
		data.ExplodePosY = parsed.EndPos.Y
		data.ExplodePosZ = parsed.EndPos.Z
	}

	// Траектория
	if len(parsed.Trajectory) > 0 {
		data.Trajectory = make([][]float64, len(parsed.Trajectory))
		for i, point := range parsed.Trajectory {
			data.Trajectory[i] = []float64{point.X, point.Y, point.Z}
		}
	}
	if len(parsed.TrajectoryTicks) > 0 {
		data.TrajectoryTicks = append([]int(nil), parsed.TrajectoryTicks...)
	}
	if options.IncludeTrajectoryDense && len(parsed.TrajectoryDense) > 0 {
		data.TrajectoryDense = make([][]float64, len(parsed.TrajectoryDense))
		for i, point := range parsed.TrajectoryDense {
			data.TrajectoryDense[i] = []float64{point.X, point.Y, point.Z}
		}
	}
	if options.IncludeTrajectoryDense && len(parsed.TrajectoryDenseTicks) > 0 {
		data.TrajectoryDenseTicks = append([]int(nil), parsed.TrajectoryDenseTicks...)
	}

	// Entity ID
	if options.IncludeThrowerSteamID64 {
		data.ThrowerSteamID64 = parsed.ThrowerSteamID64
	}

	if options.IncludeThrowerEntityID && parsed.ThrowerEntityID != nil {
		data.ThrowerEntityID = parsed.ThrowerEntityID
	}

	if options.IncludeProjectileEntityID && parsed.ProjectileEntityID != nil {
		data.ProjectileEntityID = parsed.ProjectileEntityID
	}

	// Thrower AccountID (из SteamID64)
	// SteamID64 = 76561198000000000 + AccountID
	if options.IncludeThrowerAccountID && parsed.ThrowerSteamID64 > 76561197960265728 {
		data.ThrowerAccountID = parsed.ThrowerSteamID64 - 76561197960265728
	}

	return data
}

// ParseAndConvert анализирует демофайлы и конвертирует в формат для API
func ParseAndConvert(filePath string) ([]models.GrenadeData, error) {
	return ParseAndConvertWithOptions(filePath, DefaultOutputOptions())
}

func ParseAndConvertWithOptions(filePath string, options OutputOptions) ([]models.GrenadeData, error) {
	var parsedGrenades []*models.ParsedGrenade
	var err error

	// Проверяем, файл это или директория
	info, err := os.Stat(filePath)
	if err != nil {
		return nil, fmt.Errorf("ошибка доступа к пути: %w", err)
	}

	if info.IsDir() {
		parsedGrenades, err = ParseDemoDirectoryWithOptions(filePath, options)
	} else {
		parsedGrenades, err = ParseDemoFileWithOptions(filePath, options)
	}

	if err != nil {
		return nil, err
	}

	// Конвертируем в формат для API
	grenadeDataList := make([]models.GrenadeData, len(parsedGrenades))
	for i, parsed := range parsedGrenades {
		grenadeDataList[i] = ConvertToGrenadeDataWithOptions(parsed, options)
	}

	return grenadeDataList, nil
}

// Close закрывает парсер и освобождает ресурсы
func (p *DemoParser) Close() {
	// Очистка памяти
	p.grenades = nil
}
