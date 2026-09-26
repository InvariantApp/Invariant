// A renamed field the SDK declares on the struct its response type embeds.
package scenario

import (
	"context"

	"example.com/sdk"
)

// EmailOf is a customer's email address.
func EmailOf(ctx context.Context, client *sdk.Client, id string) (string, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return customer.Email, nil
}
