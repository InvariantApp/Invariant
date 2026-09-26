// The request body's field is renamed; the response's field of the same name
// is not, and is what this reads.
package scenario

import (
	"context"

	"example.com/sdk"
)

// NameOf is a customer's name.
func NameOf(ctx context.Context, client *sdk.Client, id string) (string, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return customer.Nickname, nil
}
