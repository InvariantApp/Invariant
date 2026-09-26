// The SDK's type named through the consumer's own alias.
package scenario

import (
	"example.com/sdk"
)

// Account is what this service calls a customer.
type Account = sdk.Customer

// Label is an account's label.
func Label(account *Account) string {
	return account.Nickname
}
