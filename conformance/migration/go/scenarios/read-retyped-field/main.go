// A field that is now RFC 3339 text, read and used as epoch seconds.
package scenario

import (
	"context"

	"example.com/sdk"
)

// AgeInDays is how long ago a customer was created.
func AgeInDays(ctx context.Context, client *sdk.Client, id string, now int64) (float64, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return 0, err
	}
	return float64(now-customer.Created) / 86400, nil // <- flag
}
