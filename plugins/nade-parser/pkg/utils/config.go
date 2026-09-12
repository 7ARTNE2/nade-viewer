package utils

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
)

// Config представляет конфигурацию парсера
type Config struct {
	DemosDirs                 []string `json:"demos_dirs"`
	DjangoAPIURL              string   `json:"django_api_url"`
	AuthToken                 string   `json:"auth_token"`
	BatchSize                 int      `json:"batch_size"`
	Dedup                     bool     `json:"dedup"`
	Mode                      string   `json:"mode"`
	IndexPath                 string   `json:"index_path"`
	DemoChunkSize             int      `json:"demo_chunk_size"`
	ParseWorkers              int      `json:"parse_workers"`
	IncludeTrajectoryDense    bool     `json:"include_trajectory_dense"`
	IncludeThrowerSteamID64   bool     `json:"include_thrower_steamid64"`
	IncludeThrowerAccountID   bool     `json:"include_thrower_accountid"`
	IncludeThrowerEntityID    bool     `json:"include_thrower_entity_id"`
	IncludeProjectileEntityID bool     `json:"include_projectile_entity_id"`
	ProgressJSON              bool     `json:"progress_json"`
}

// DefaultConfig возвращает конфигурацию по умолчанию
func DefaultConfig() *Config {
	workers := runtime.NumCPU() / 2
	if workers < 1 {
		workers = 1
	}

	return &Config{
		DemosDirs:                 []string{"./demos"},
		DjangoAPIURL:              "http://localhost:8000",
		AuthToken:                 "",
		BatchSize:                 100,
		Dedup:                     true,
		Mode:                      "sync",
		IndexPath:                 "./grenade_index.json",
		DemoChunkSize:             25,
		ParseWorkers:              workers,
		IncludeTrajectoryDense:    false,
		IncludeThrowerSteamID64:   true,
		IncludeThrowerAccountID:   true,
		IncludeThrowerEntityID:    true,
		IncludeProjectileEntityID: true,
		ProgressJSON:              false,
	}
}

// LoadConfig загружает конфигурацию из JSON файла
func LoadConfig(path string) (*Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("ошибка открытия файла конфигурации: %w", err)
	}
	defer file.Close()

	config := *DefaultConfig()
	decoder := json.NewDecoder(file)
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("ошибка парсинга конфигурации: %w", err)
	}

	return &config, nil
}

// SaveConfig сохраняет конфигурацию в JSON файл
func SaveConfig(config *Config, path string) error {
	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("ошибка создания файла конфигурации: %w", err)
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(config)
}
