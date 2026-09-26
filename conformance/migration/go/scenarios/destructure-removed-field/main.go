// A removed field assigned to a local, with another.
package scenario

import (
	"example.com/sdk"
)

// Reachable is where a customer can be reached.
func Reachable(customer *sdk.Customer) []string {
	fax, email := customer.Fax, customer.Email // <- flag
	if fax == nil {
		return []string{email}
	}
	return []string{email, *fax}
}
