package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"nadesoulpars/pkg/models"
	"net/http"
)

// Client представляет клиент для взаимодействия с Django API
type Client struct {
	BaseURL    string
	AuthToken  string
	HTTPClient *http.Client
}

// NewClient создаёт новый API клиент
func NewClient(baseURL, authToken string) *Client {
	return &Client{
		BaseURL:    baseURL,
		AuthToken:  authToken,
		HTTPClient: &http.Client{},
	}
}

// ImportGrenades отправляет список гранат в Django API
func (c *Client) ImportGrenades(grenades []models.GrenadeData) (*ImportResponse, error) {
	url := c.BaseURL + "/api/import-grenades/"

	jsonData, err := json.Marshal(grenades)
	if err != nil {
		return nil, fmt.Errorf("ошибка сериализации JSON: %w", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("ошибка создания запроса: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	if c.AuthToken != "" {
		req.Header.Set("Authorization", "Token "+c.AuthToken)
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ошибка отправки запроса: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("ошибка чтения ответа: %w", err)
	}

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("ошибка API (статус %d): %s", resp.StatusCode, string(body))
	}

	var importResp ImportResponse
	if err := json.Unmarshal(body, &importResp); err != nil {
		return nil, fmt.Errorf("ошибка парсинга ответа: %w", err)
	}

	return &importResp, nil
}

// ImportResponse представляет ответ от API импорта
type ImportResponse struct {
	Created int      `json:"created"`
	Updated int      `json:"updated"`
	Errors  []string `json:"errors"`
}

// HealthCheck проверяет доступность API
func (c *Client) HealthCheck() error {
	url := c.BaseURL + "/api/health/"

	resp, err := c.HTTPClient.Get(url)
	if err != nil {
		return fmt.Errorf("ошибка проверки здоровья API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("API вернул статус %d", resp.StatusCode)
	}

	return nil
}
