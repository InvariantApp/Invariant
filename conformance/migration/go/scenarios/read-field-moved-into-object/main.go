// A field that moved into a nested object, read from where it used to be.
package scenario

import (
	"context"

	"example.com/sdk"
)

// PhoneOf is a customer's phone number.
func PhoneOf(ctx context.Context, client *sdk.Client, id string) (string, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return customer.Phone, nil
}
