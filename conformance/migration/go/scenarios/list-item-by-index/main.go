// A renamed field of a list item, read by index.
package scenario

import (
	"example.com/sdk"
)

// FirstDigits is the last digits of a customer's first card.
func FirstDigits(customer *sdk.Customer) string {
	return customer.Cards[0].Last4
}
