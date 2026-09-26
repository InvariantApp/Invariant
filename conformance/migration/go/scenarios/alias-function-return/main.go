// The consumer's own function returns the response; the field is read off the
// call.
package scenario

import (
	"context"

	"example.com/sdk"
)

func load(ctx context.Context, client *sdk.Client, id string) *sdk.Customer {
	customer, _ := client.Customers.Get(ctx, id)
	return customer
}

// NameOf is a customer's name.
func NameOf(ctx context.Context, client *sdk.Client, id string) string {
	return load(ctx, client, id).Nickname
}
