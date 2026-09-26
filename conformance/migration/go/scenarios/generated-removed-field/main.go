// A removed field read through structs oapi-codegen generated.
package scenario

import (
	"example.com/sdk/gen"
)

// FaxOf is a customer's fax number.
func FaxOf(customer *gen.Customer) *string {
	return customer.Fax // <- flag
}
