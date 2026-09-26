// A request amount now sent in minor units, written as a computed value.
package scenario

import (
	"context"

	"example.com/sdk"
)

// SignUp creates a customer.
func SignUp(ctx context.Context, client *sdk.Client, email string, credit float64) (*sdk.Customer, error) {
	return client.Customers.Create(ctx, &sdk.CustomerCreateParams{Email: email, Balance: credit * 2})
}
