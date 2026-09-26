// The response's status shares the request's value type, and only the
// request's values were renamed.
package scenario

import (
	"example.com/sdk"
)

// IsLive reports whether a customer is live.
func IsLive(customer *sdk.Customer) bool {
	return customer.Status == "active"
}
