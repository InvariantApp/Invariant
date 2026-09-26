// Package sdk is a hand-written SDK in go-github's shape, at the release that
// speaks the new contract: every Change in the conformance manifest is made
// here, and nothing else.
package sdk

import "context"

// CustomerStatus is one of the values a customer's status takes.
type CustomerStatus string

// The statuses a customer can have.
const (
	CustomerStatusEnabled  CustomerStatus = "enabled"
	CustomerStatusInactive CustomerStatus = "inactive"
)

// Address is a postal address.
type Address struct {
	Line1    string `json:"line1"`
	Postcode string `json:"postcode"`
	City     string `json:"city"`
}

// Card is a payment card on file.
type Card struct {
	ID       string `json:"id"`
	Brand    string `json:"brand"`
	LastFour string `json:"last_four"`
}

// Contact is how to reach a customer.
type Contact struct {
	Phone string `json:"phone"`
}

// CustomerBase is what every object about a person carries.
type CustomerBase struct {
	ID           string `json:"id"`
	EmailAddress string `json:"email_address"`
}

// Customer is a customer as the API sends it.
type Customer struct {
	CustomerBase
	Object          string         `json:"object"`
	DisplayName     string         `json:"display_name"`
	Created         string         `json:"created"`
	Status          CustomerStatus `json:"status"`
	Balance         int64          `json:"balance"`
	Contact         *Contact       `json:"contact"`
	PreferredLocale *string        `json:"preferred_locale"`
	Address         *Address       `json:"address"`
	Cards           []*Card        `json:"cards"`
}

// CustomerCreateParams creates a customer.
type CustomerCreateParams struct {
	Email       string         `json:"email,omitempty"`
	DisplayName string         `json:"display_name,omitempty"`
	Status      CustomerStatus `json:"status,omitempty"`
	Balance     int64          `json:"balance,omitempty"`
	Contact     *Contact       `json:"contact,omitempty"`
	Address     *Address       `json:"address,omitempty"`
	TaxExempt   string         `json:"tax_exempt"`
}

// Merchant is another object with a nickname of its own.
type Merchant struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
}

// Person is a customer as a part of the SDK written by hand names its
// fields, whatever the wire calls them.
type Person struct {
	ID         string `json:"id"`
	ScreenName string `json:"display_name"`
}

// ToMinorUnits is an amount in major units as minor units, exactly.
func ToMinorUnits(amount float64) int64 { return 0 }

// FromMinorUnits is an amount in minor units as major units, exactly.
func FromMinorUnits(minor int64) float64 { return 0 }

// CustomersService is the customers part of the API.
type CustomersService struct{}

// Get retrieves a customer.
func (s *CustomersService) Get(ctx context.Context, id string) (*Customer, error) {
	return nil, nil
}

// Create creates a customer.
func (s *CustomersService) Create(ctx context.Context, params *CustomerCreateParams) (*Customer, error) {
	return nil, nil
}

// MerchantsService is the merchants part of the API.
type MerchantsService struct{}

// Get retrieves a merchant.
func (s *MerchantsService) Get(ctx context.Context, id string) (*Merchant, error) {
	return nil, nil
}

// PeopleService is the people part of the API.
type PeopleService struct{}

// Get retrieves a person.
func (s *PeopleService) Get(ctx context.Context, id string) (*Person, error) {
	return nil, nil
}

// Client talks to the API.
type Client struct {
	Customers *CustomersService
	Merchants *MerchantsService
	People    *PeopleService
}

// NewClient returns a client that authenticates with token.
func NewClient(token string) *Client { return &Client{} }
