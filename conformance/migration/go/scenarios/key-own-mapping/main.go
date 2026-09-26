// The consumer's own typed map has an entry with the field's name.
package scenario

import (
	"context"
	"strings"

	"example.com/sdk"
)

var labels = map[string]string{"nickname": "Nickname", "email": "Email"}

// Heading is a customer's heading.
func Heading(ctx context.Context, client *sdk.Client, id string) (string, error) {
	customer, err := client.Customers.Get(ctx, id)
	if err != nil {
		return "", err
	}
	return strings.Join([]string{labels["nickname"], customer.ID}, ": "), nil
}
