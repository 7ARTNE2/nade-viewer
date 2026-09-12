package indexer

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/vmihailenco/msgpack/v5"

	"nadesoulpars/pkg/models"
)

type State struct {
	Version        int                  `json:"version" msgpack:"version"`
	UpdatedAt      string               `json:"updated_at" msgpack:"updated_at"`
	Canonical      []models.GrenadeData `json:"canonical_grenades" msgpack:"canonical_grenades"`
	ProcessedDemos []string             `json:"processed_demos" msgpack:"processed_demos"`
}

func NewState() *State {
	return &State{
		Version:        1,
		Canonical:      make([]models.GrenadeData, 0),
		ProcessedDemos: make([]string, 0),
	}
}

func Load(path string) (*State, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var state State
	if isMessagePackPath(path) {
		err = msgpack.NewDecoder(file).Decode(&state)
	} else {
		err = json.NewDecoder(file).Decode(&state)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to decode index state: %w", err)
	}

	if state.Version == 0 {
		state.Version = 1
	}
	if state.Canonical == nil {
		state.Canonical = make([]models.GrenadeData, 0)
	}
	if state.ProcessedDemos == nil {
		state.ProcessedDemos = make([]string, 0)
	}

	return &state, nil
}

func LoadOrCreate(path string) (*State, error) {
	state, err := Load(path)
	if err == nil {
		return state, nil
	}
	if os.IsNotExist(err) {
		return NewState(), nil
	}
	return nil, err
}

func (s *State) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil && filepath.Dir(path) != "." {
		return fmt.Errorf("failed to create index directory: %w", err)
	}

	s.Version = 1
	s.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	sort.Strings(s.ProcessedDemos)

	file, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("failed to create index file: %w", err)
	}
	defer file.Close()

	if isMessagePackPath(path) {
		if err := msgpack.NewEncoder(file).Encode(s); err != nil {
			return fmt.Errorf("failed to encode index state: %w", err)
		}
		return nil
	}

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(s); err != nil {
		return fmt.Errorf("failed to encode index state: %w", err)
	}

	return nil
}

func isMessagePackPath(path string) bool {
	extension := strings.ToLower(filepath.Ext(path))
	return extension == ".msgpack" || extension == ".mpk"
}

func (s *State) ProcessedSet() map[string]struct{} {
	out := make(map[string]struct{}, len(s.ProcessedDemos))
	for _, item := range s.ProcessedDemos {
		out[item] = struct{}{}
	}
	return out
}

func (s *State) MarkProcessed(demoIDs []string) {
	if len(demoIDs) == 0 {
		return
	}

	seen := s.ProcessedSet()
	for _, demoID := range demoIDs {
		if _, exists := seen[demoID]; exists {
			continue
		}
		seen[demoID] = struct{}{}
		s.ProcessedDemos = append(s.ProcessedDemos, demoID)
	}
}
