// A test's stand-in for a response, built as the SDK's struct, holding a field
// whose encoding changed.
package scenario

import (
	"example.com/sdk"
)

// FakeCustomer is a customer for tests.
func FakeCustomer() *sdk.Customer {
	return &sdk.Customer{
		CustomerBase: sdk.CustomerBase{ID: "cus_1", Email: "ada@example.com"},
		Object:       "customer",
		Created:      1700000000, // <- flag
	}
}
