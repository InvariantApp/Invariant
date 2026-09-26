// An amount now in minor units, read from a response that may be nil.
package scenario

import (
	"example.com/sdk"
)

// Owed is what a customer owes, if there is a customer.
func Owed(customer *sdk.Customer) float64 {
	if customer == nil {
		return 0
	}
	return customer.Balance // <- flag
}
