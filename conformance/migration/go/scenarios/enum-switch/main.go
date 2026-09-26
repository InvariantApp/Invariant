// A renamed enum value as a case of a switch over the response's field.
package scenario

import (
	"example.com/sdk"
)

// Badge is a customer's badge.
func Badge(customer *sdk.Customer) string {
	switch customer.Status {
	case "active":
		return "Live"
	case "inactive":
		return "Paused"
	}
	return ""
}
