// A field the response's list items lost.
package scenario

import (
	"example.com/sdk"
)

// Fingerprints is the fingerprint of each of a customer's cards.
func Fingerprints(customer *sdk.Customer) []string {
	var found []string
	for _, card := range customer.Cards {
		found = append(found, card.Fingerprint) // <- flag
	}
	return found
}
