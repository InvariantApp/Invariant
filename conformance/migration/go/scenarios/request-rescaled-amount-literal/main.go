// A request amount now sent in minor units, written as a literal.
package scenario

import (
	"context"

	"example.com/sdk"
)

// SignUp creates a customer.
func SignUp(ctx context.Context, client *sdk.Client, email string) (*sdk.Customer, error) {
	return client.Customers.Create(ctx, &sdk.CustomerCreateParams{Email: email, Balance: 12.5})
}
