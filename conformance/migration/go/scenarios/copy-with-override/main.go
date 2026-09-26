// A copy of the response with the renamed field overridden.
package scenario

import (
	"example.com/sdk"
)

// Renamed is a copy of a customer under another name.
func Renamed(customer *sdk.Customer, name string) *sdk.Customer {
	changed := *customer
	changed.Nickname = name
	return &changed
}
