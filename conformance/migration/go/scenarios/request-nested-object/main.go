// A renamed field of a nested object, written inside a request.
package scenario

import (
	"context"

	"example.com/sdk"
)

// SignUp creates a customer.
func SignUp(ctx context.Context, client *sdk.Client, email, line1, city, zip string) (*sdk.Customer, error) {
	return client.Customers.Create(ctx, &sdk.CustomerCreateParams{
		Email:   email,
		Address: &sdk.Address{Line1: line1, PostalCode: zip, City: city},
	})
}
