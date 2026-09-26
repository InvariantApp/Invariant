// The consumer's own type holding the response.
package scenario

import (
	"example.com/sdk"
)

// Account is this service's view of a customer.
type Account struct {
	customer *sdk.Customer
}

// Name is the account's name.
func (a *Account) Name() string {
	return a.customer.Nickname
}
