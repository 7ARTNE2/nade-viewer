package parser

import (
	"fmt"
	"math"
	"nadesoulpars/pkg/models"
	"sort"
	"strings"
)

const (
	startPosTolerance   = 10.0
	explodePosTolerance = 20.0
)

type DedupStats struct {
	OriginalCount   int
	DedupedCount    int
	RemovedCount    int
	ClusterCount    int
	MergedUsageGain int
}

type position3D struct {
	x float64
	y float64
	z float64
}

// DeduplicateGrenades collapses near-identical lineups before API import.
// Duplicates are matched inside the same map/side/type by position tolerances:
// start_pos within 10 units and explode_pos within 20 units.
// Clusters are built conservatively around a representative grenade.
// A grenade joins a cluster only if it stays close to the representative
// and does not expand the cluster diameter beyond the configured tolerances.
func DeduplicateGrenades(grenades []models.GrenadeData) ([]models.GrenadeData, DedupStats) {
	stats := DedupStats{OriginalCount: len(grenades)}
	if len(grenades) == 0 {
		return nil, stats
	}

	groups := make(map[string][]models.GrenadeData)
	order := make([]string, 0)

	for _, grenade := range grenades {
		signature := grenadeSignature(grenade)
		if _, exists := groups[signature]; !exists {
			order = append(order, signature)
		}
		groups[signature] = append(groups[signature], grenade)
	}

	result := make([]models.GrenadeData, 0, len(grenades))
	clusterCount := 0

	for _, signature := range order {
		items := groups[signature]
		clusters := buildStableClusters(items)
		clusterCount += len(clusters)

		for _, clusterItems := range clusters {
			representative := chooseClusterRepresentative(clusterItems)
			clusterUsage := totalUsage(clusterItems)
			representative.UsageCount = clusterUsage
			representative.UsageThrowers = uniqueThrowers(clusterItems)

			if representative.ThrowKeys == "" {
				representative.ThrowKeys = dominantThrowKeys(clusterItems)
			}
			if representative.LineupTick == nil {
				representative.LineupTick = firstNonNilLineupTick(clusterItems)
			}

			result = append(result, representative)
			stats.MergedUsageGain += clusterUsage - normalizedUsage(representative)
		}
	}

	stats.ClusterCount = clusterCount
	stats.DedupedCount = len(result)
	stats.RemovedCount = stats.OriginalCount - stats.DedupedCount
	return result, stats
}

func buildStableClusters(items []models.GrenadeData) [][]models.GrenadeData {
	if len(items) == 0 {
		return nil
	}

	clusters := make([][]models.GrenadeData, 0)

	for _, item := range items {
		bestClusterIdx := -1
		bestScore := math.MaxFloat64

		for i, cluster := range clusters {
			if !canJoinCluster(cluster, item) {
				continue
			}

			score := clusterFitScore(cluster, item)
			if score < bestScore {
				bestScore = score
				bestClusterIdx = i
			}
		}

		if bestClusterIdx >= 0 {
			clusters[bestClusterIdx] = append(clusters[bestClusterIdx], item)
			continue
		}

		clusters = append(clusters, []models.GrenadeData{item})
	}

	return clusters
}

func canJoinCluster(cluster []models.GrenadeData, item models.GrenadeData) bool {
	if len(cluster) == 0 {
		return true
	}

	representative := chooseClusterRepresentative(cluster)
	if !areDuplicateCandidates(representative, item) {
		return false
	}

	for _, existing := range cluster {
		if !withinTolerance(posFromStart(existing), posFromStart(item), startPosTolerance) {
			return false
		}
		if !withinTolerance(posFromExplode(existing), posFromExplode(item), explodePosTolerance) {
			return false
		}
	}

	return true
}

func clusterFitScore(cluster []models.GrenadeData, item models.GrenadeData) float64 {
	representative := chooseClusterRepresentative(cluster)
	startDist := distance(posFromStart(representative), posFromStart(item))
	explodeDist := distance(posFromExplode(representative), posFromExplode(item))
	return startDist + explodeDist
}

func areDuplicateCandidates(a, b models.GrenadeData) bool {
	if grenadeSignature(a) != grenadeSignature(b) {
		return false
	}
	if !withinTolerance(posFromStart(a), posFromStart(b), startPosTolerance) {
		return false
	}
	if !withinTolerance(posFromExplode(a), posFromExplode(b), explodePosTolerance) {
		return false
	}
	return true
}

func grenadeSignature(g models.GrenadeData) string {
	return strings.ToLower(fmt.Sprintf("%s|%s|%s", g.Map, g.Side, g.GrenadeType))
}

func posFromStart(g models.GrenadeData) position3D {
	return position3D{x: g.StartPosX, y: g.StartPosY, z: g.StartPosZ}
}

func posFromExplode(g models.GrenadeData) position3D {
	return position3D{x: g.ExplodePosX, y: g.ExplodePosY, z: g.ExplodePosZ}
}

func withinTolerance(a, b position3D, tolerance float64) bool {
	return distance(a, b) <= tolerance
}

func distance(a, b position3D) float64 {
	dx := a.x - b.x
	dy := a.y - b.y
	dz := a.z - b.z
	return math.Sqrt(dx*dx + dy*dy + dz*dz)
}

func dominantThrowKeys(items []models.GrenadeData) string {
	weights := make(map[string]int)
	bestDesc := ""
	bestWeight := 0

	for _, item := range items {
		desc := normalizeDescription(item.ThrowKeys)
		if desc == "" {
			continue
		}

		weights[desc] += normalizedUsage(item)
		if weights[desc] > bestWeight || (weights[desc] == bestWeight && betterDescription(desc, bestDesc)) {
			bestDesc = desc
			bestWeight = weights[desc]
		}
	}

	return bestDesc
}

func chooseClusterRepresentative(items []models.GrenadeData) models.GrenadeData {
	bestDesc := dominantThrowKeys(items)
	bestIdx := 0

	for i := 1; i < len(items); i++ {
		if betterCandidate(items[i], items[bestIdx], bestDesc) {
			bestIdx = i
		}
	}

	representative := items[bestIdx]
	if bestDesc != "" {
		representative.ThrowKeys = bestDesc
	}
	return representative
}

func betterCandidate(current, best models.GrenadeData, preferredDesc string) bool {
	currentDescMatch := normalizeDescription(current.ThrowKeys) == preferredDesc && preferredDesc != ""
	bestDescMatch := normalizeDescription(best.ThrowKeys) == preferredDesc && preferredDesc != ""
	if currentDescMatch != bestDescMatch {
		return currentDescMatch
	}

	if normalizedUsage(current) != normalizedUsage(best) {
		return normalizedUsage(current) > normalizedUsage(best)
	}

	if trajectoryLen(current) != trajectoryLen(best) {
		return trajectoryLen(current) > trajectoryLen(best)
	}

	if hasCoordinates(current) != hasCoordinates(best) {
		return hasCoordinates(current)
	}

	if len(strings.TrimSpace(current.ThrowKeys)) != len(strings.TrimSpace(best.ThrowKeys)) {
		return len(strings.TrimSpace(current.ThrowKeys)) > len(strings.TrimSpace(best.ThrowKeys))
	}

	if current.Airtime != best.Airtime {
		return current.Airtime > best.Airtime
	}

	return false
}

func normalizedUsage(item models.GrenadeData) int {
	if item.UsageCount > 0 {
		return item.UsageCount
	}
	return 1
}

func totalUsage(items []models.GrenadeData) int {
	total := 0
	for _, item := range items {
		total += normalizedUsage(item)
	}
	return total
}

func firstNonNilLineupTick(items []models.GrenadeData) *int {
	for _, item := range items {
		if item.LineupTick == nil {
			continue
		}

		value := *item.LineupTick
		return &value
	}

	return nil
}

func uniqueThrowers(items []models.GrenadeData) []string {
	seen := make(map[string]struct{})
	throwers := make([]string, 0)

	for _, item := range items {
		for _, thrower := range item.UsageThrowers {
			addUniqueThrower(seen, &throwers, thrower)
		}
		addUniqueThrower(seen, &throwers, item.Thrower)
	}

	sort.Strings(throwers)
	return throwers
}

func addUniqueThrower(seen map[string]struct{}, throwers *[]string, raw string) {
	thrower := strings.TrimSpace(raw)
	if thrower == "" {
		return
	}
	key := strings.ToLower(thrower)
	if _, exists := seen[key]; exists {
		return
	}
	seen[key] = struct{}{}
	*throwers = append(*throwers, thrower)
}

func normalizeDescription(desc string) string {
	return strings.ToUpper(strings.TrimSpace(desc))
}

func betterDescription(current, best string) bool {
	if best == "" {
		return current != ""
	}
	if len(current) != len(best) {
		return len(current) > len(best)
	}
	return current < best
}

func trajectoryLen(item models.GrenadeData) int {
	return len(item.Trajectory)
}

func hasCoordinates(item models.GrenadeData) bool {
	return strings.TrimSpace(item.Coordinates) != ""
}
