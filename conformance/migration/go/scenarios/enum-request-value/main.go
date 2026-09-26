// A renamed enum value sent in a request.
package scenario

import (
	"context"

	"example.com/sdk"
)

// SignUp creates a customer.
func SignUp(ctx context.Context, client *sdk.Client, email string) (*sdk.Customer, error) {
	return client.Customers.Create(ctx, &sdk.CustomerCreateParams{Email: email, Status: "active"})
}
