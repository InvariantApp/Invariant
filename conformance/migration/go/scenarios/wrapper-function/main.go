// The consumer's own wrapper over the SDK, handed a function that reads the
// renamed field.
package scenario

import (
	"context"

	"example.com/sdk"
)

func withCustomer[T any](ctx context.Context, client *sdk.Client, id string, read func(*sdk.Customer) T) (T, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		var zero T
		return zero, err
	}
	return read(customer), nil
}

// NameOf is a customer's name.
func NameOf(ctx context.Context, client *sdk.Client, id string) (string, error) {
	return withCustomer(ctx, client, id, func(customer *sdk.Customer) string { return customer.Nickname })
}
