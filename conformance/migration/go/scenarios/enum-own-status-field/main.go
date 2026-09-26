// The consumer's own struct has a status compared with the old value's
// spelling.
package scenario

import (
	"example.com/sdk"
)

// Order is an order this service keeps.
type Order struct {
	Status   string
	Customer *sdk.Customer
}

// Open reports whether an order is open.
func Open(order Order) bool {
	return order.Status == "active" && order.Customer.ID != ""
}
