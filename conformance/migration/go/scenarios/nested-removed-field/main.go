// A field the response's nested object lost.
package scenario

import (
	"example.com/sdk"
)

// SecondLine is the second line of a customer's address.
func SecondLine(customer *sdk.Customer) *string {
	return customer.Address.Line2 // <- flag
}
