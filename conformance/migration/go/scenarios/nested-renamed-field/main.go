// A renamed field of a nested object, read through the response.
package scenario

import (
	"example.com/sdk"
)

// ZipOf is a customer's postal code.
func ZipOf(customer *sdk.Customer) string {
	return customer.Address.PostalCode
}
