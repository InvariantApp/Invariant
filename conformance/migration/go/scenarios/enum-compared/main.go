// A renamed enum value compared with the response's field.
package scenario

import (
	"example.com/sdk"
)

// IsLive reports whether a customer is live.
func IsLive(customer *sdk.Customer) bool {
	return customer.Status == "active"
}
