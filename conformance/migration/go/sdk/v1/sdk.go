// Package sdk is a hand-written SDK in go-github's shape, at the release the
// consumer uses today: a struct per object, each field tagged with the wire
// name it is sent as, and services on a client.
package sdk

import "context"

// CustomerStatus is one of the values a customer's status takes.
type CustomerStatus string

// The statuses a customer can have.
const (
	CustomerStatusActive   CustomerStatus = "active"
	CustomerStatusInactive CustomerStatus = "inactive"
)

// Address is a postal address.
type Address struct {
	Line1      string  `json:"line1"`
	Line2      *string `json:"line2"`
	PostalCode string  `json:"postal_code"`
	City       string  `json:"city"`
}

// Card is a payment card on file.
type Card struct {
	ID          string `json:"id"`
	Brand       string `json:"brand"`
	Last4       string `json:"last4"`
	Fingerprint string `json:"fingerprint"`
}

// CustomerBase is what every object about a person carries.
type CustomerBase struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

// Customer is a customer as the API sends it.
type Customer struct {
	CustomerBase
	Object   string         `json:"object"`
	Nickname string         `json:"nickname"`
	Fax      *string        `json:"fax"`
	Created  int64          `json:"created"`
	Status   CustomerStatus `json:"status"`
	Balance  float64        `json:"balance"`
	Phone    string         `json:"phone"`
	Address  *Address       `json:"address"`
	Cards    []*Card        `json:"cards"`
}

// CustomerCreateParams creates a customer.
type CustomerCreateParams struct {
	Email    string         `json:"email,omitempty"`
	Nickname string         `json:"nickname,omitempty"`
	Fax      string         `json:"fax,omitempty"`
	Status   CustomerStatus `json:"status,omitempty"`
	Balance  float64        `json:"balance,omitempty"`
	Phone    string         `json:"phone,omitempty"`
	Address  *Address       `json:"address,omitempty"`
}

// Merchant is another object with a nickname of its own.
type Merchant struct {
	ID       string `json:"id"`
	Nickname string `json:"nickname"`
}

// Person is a customer as a part of the SDK written by hand names its
// fields, whatever the wire calls them.
type Person struct {
	ID     string `json:"id"`
	Handle string `json:"nickname"`
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
