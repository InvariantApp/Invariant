// The renamed field read with a fallback from untyped JSON.
package scenario

import (
	"context"
	"encoding/json"

	"example.com/sdk"
)

// OnEvent is the name of the customer a webhook is about.
func OnEvent(ctx context.Context, client *sdk.Client, body []byte) (string, error) {
	var event map[string]any
	if err := json.Unmarshal(body, &event); err != nil {
		return "", err
	}
	object := event["data"].(map[string]any)["object"].(map[string]any)
	if _, err := client.Customers.Get(ctx, object["id"].(string)); err != nil {
		return "", err
	}
	name, ok := object["nickname"].(string) // <- flag
	if !ok {
		name = "friend"
	}
	return name, nil
}
