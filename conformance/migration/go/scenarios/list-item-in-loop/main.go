// A renamed field of a list item, read in a loop.
package scenario

import (
	"example.com/sdk"
)

// Digits is the last digits of each of a customer's cards.
func Digits(customer *sdk.Customer) []string {
	var found []string
	for _, card := range customer.Cards {
		found = append(found, card.Last4)
	}
	return found
}
