// The response passed to the consumer's own function, typed as the SDK's.
package scenario

import (
	"context"

	"example.com/sdk"
)

func label(customer *sdk.Customer) string {
	return customer.Nickname
}

// Show is a customer's label.
func Show(ctx context.Context, client *sdk.Client, id string) (string, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return label(customer), nil
}
