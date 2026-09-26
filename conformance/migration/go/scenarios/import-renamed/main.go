// The SDK's package imported under another name.
package scenario

import (
	"context"

	acme "example.com/sdk"
)

func label(customer *acme.Customer) string {
	return customer.Nickname
}

// Show is a customer's label.
func Show(ctx context.Context, client *acme.Client, id string) (string, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return label(customer), nil
}
