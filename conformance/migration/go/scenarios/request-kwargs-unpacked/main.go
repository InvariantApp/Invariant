// Request parameters gathered in a value first, then handed to the SDK's call.
package scenario

import (
	"context"

	"example.com/sdk"
)

// SignUp creates a customer.
func SignUp(ctx context.Context, client *sdk.Client, email, name string) (*sdk.Customer, error) {
	params := sdk.CustomerCreateParams{Email: email, Nickname: name}
	return client.Customers.Create(ctx, &params)
}
