// The request's status shares the response's value type, and only the
// response's values were renamed.
package scenario

import (
	"context"

	"example.com/sdk"
)

// SignUp creates a customer.
func SignUp(ctx context.Context, client *sdk.Client, email string) (*sdk.Customer, error) {
	return client.Customers.Create(ctx, &sdk.CustomerCreateParams{Email: email, Status: "active"})
}
