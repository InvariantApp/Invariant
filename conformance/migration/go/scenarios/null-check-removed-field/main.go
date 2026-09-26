// A removed field checked for nil before use.
package scenario

import (
	"example.com/sdk"
)

// FaxOf is a customer's fax number, if there is one.
func FaxOf(customer *sdk.Customer) string {
	if customer.Fax == nil { // <- flag
		return ""
	}
	return *customer.Fax // <- flag
}
