// A recorded webhook, kept as the untyped JSON the API sent, which names its
// own schema.
package scenario

import (
	"context"

	"example.com/sdk"
)

var recorded = map[string]any{
	"type": "customer.updated",
	"data": map[string]any{
		"object": map[string]any{
			"object":   "customer",
			"id":       "cus_1",
			"nickname": "Ada", // <- flag
		},
	},
}

// Replay fetches the customer the recorded event is about.
func Replay(ctx context.Context, client *sdk.Client) (*sdk.Customer, error) {
	object := recorded["data"].(map[string]any)["object"].(map[string]any)
	return client.Customers.Get(ctx, object["id"].(string))
}
