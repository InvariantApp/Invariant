// A response object's removed field, read directly.
package scenario

import (
	"context"

	"example.com/sdk"
)

// FaxOf is a customer's fax number.
func FaxOf(ctx context.Context, client *sdk.Client, id string) (*string, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	return customer.Fax, nil // <- flag
}
