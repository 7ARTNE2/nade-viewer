package utils

import (
	"strings"
)

// MapNameMap маппинг названий карт из CS2 в формат Django
var MapNameMap = map[string]string{
	"de_dust2":      "Dust2",
	"de_inferno":    "Inferno",
	"de_mirage":     "Mirage",
	"de_ancient":    "Ancient",
	"de_nuke":       "Nuke",
	"de_train":      "Train",
	"de_overpass":   "Overpass",
	"de_anubis":     "Anubis",
	"de_vertigo":    "Vertigo",
	"cs_italy":      "Italy",
	"cs_office":     "Office",
	"ar_baggage":    "Baggage",
	"ar_shoots":     "Shoots",
	"de_cache":      "Cache",
	"de_cbble":      "Cobblestone",
	"de_lake":       "Lake",
	"de_safehouse":  "Safehouse",
	"de_shortdust":  "Shortdust",
	"de_shortnuke":  "Shortnuke",
	"de_stmarc":     "St. Marc",
	"de_thrill":     "Thrill",
	"de_zoo":        "Zoo",
	"de_alley":      "Alley",
	"de_chlorine":   "Chlorine",
	"de_insertion":  "Insertion",
	"de_insertion2": "Insertion II",
	"de_mills":      "Mills",
	"de_mutiny":     "Mutiny",
	"de_sugarcane":  "Sugarcane",
}

// GetDjangoMapName возвращает название карты в формате Django
func GetDjangoMapName(csMapName string) string {
	if name, ok := MapNameMap[csMapName]; ok {
		return name
	}
	// Если не найдено, возвращаем как есть (без префикса de_)
	return csMapName
}

// GetDjangoGrenadeType возвращает тип гранаты в формате Django
// weaponType - строковое представление типа оружия из demoinfocs (например, "Flashbang", "HE Grenade", "Smoke Grenade")
func GetDjangoGrenadeType(weaponType string) string {
	// Приводим к нижнему регистру для удобства сравнения
	weaponTypeLower := strings.ToLower(weaponType)

	// Проверяем по ключевым словам
	switch {
	case strings.Contains(weaponTypeLower, "flash"):
		return "flash"
	case strings.Contains(weaponTypeLower, "smoke"):
		return "smoke"
	case strings.Contains(weaponTypeLower, "molotov"):
		return "molotov"
	case strings.Contains(weaponTypeLower, "incendiary"):
		return "incendiary grenade"
	case strings.Contains(weaponTypeLower, "he") || strings.Contains(weaponTypeLower, "frag"):
		return "HE"
	default:
		return "HE" // по умолчанию
	}
}

// SideMap маппинг сторон
var SideMap = map[int]string{
	2: "T",  // TeamID.Terrorists
	3: "CT", // TeamID.CT
}

// GetDjangoSide возвращает сторону в формате Django
func GetDjangoSide(teamID int) string {
	if side, ok := SideMap[teamID]; ok {
		return side
	}
	return "Any"
}
