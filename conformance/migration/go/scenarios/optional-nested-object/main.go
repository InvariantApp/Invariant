// A renamed field of a nested object, read where either may be nil.
package scenario

import (
	"example.com/sdk"
)

// ZipOf is a customer's postal code, if there is one.
func ZipOf(customer *sdk.Customer) string {
	if customer == nil || customer.Address == nil {
		return ""
	}
	return customer.Address.PostalCode
}
