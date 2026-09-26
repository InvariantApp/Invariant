// A test's stand-in for a response, built as the SDK's struct, lacking a field
// the response now has.
package scenario

import (
	"example.com/sdk"
)

// FakeCustomer is a customer for tests.
func FakeCustomer() *sdk.Customer {
	return &sdk.Customer{ // <- flag
		CustomerBase: sdk.CustomerBase{ID: "cus_1", Email: "ada@example.com"},
		Object:       "customer",
		Nickname:     "Ada",
	}
}
