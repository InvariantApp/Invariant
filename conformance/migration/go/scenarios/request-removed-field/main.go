// A request field the API no longer accepts.
package scenario

import (
	"context"

	"example.com/sdk"
)

// SignUp creates a customer.
func SignUp(ctx context.Context, client *sdk.Client, email, faxNumber string) (*sdk.Customer, error) {
	return client.Customers.Create(ctx, &sdk.CustomerCreateParams{
		Email: email,
		Fax:   faxNumber, // <- flag
	})
}
