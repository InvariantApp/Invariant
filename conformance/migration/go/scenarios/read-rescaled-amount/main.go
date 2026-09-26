// An amount now in minor units, read where the SDK exports an exact conversion.
package scenario

import (
	"context"

	"example.com/sdk"
)

// Owed is what a customer owes.
func Owed(ctx context.Context, client *sdk.Client, id string) (float64, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return 0, err
	}
	return customer.Balance, nil
}
