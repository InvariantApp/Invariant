# A hand-written SDK in the shape stripe-python has had since 8.0: a class per
# object with its fields annotated, request parameters as TypedDicts taken by
# `**params`, and resources on a client.
from acme._amounts import from_minor_units as from_minor_units
from acme._amounts import to_minor_units as to_minor_units
from acme._client import Client as Client
from acme._customer import Address as Address
from acme._customer import AddressParams as AddressParams
from acme._customer import Card as Card
from acme._customer import Customer as Customer
from acme._customer import CustomerBase as CustomerBase
from acme._customer import CustomerCreateParams as CustomerCreateParams
from acme._customer import CustomerStatus as CustomerStatus
from acme._customer import Merchant as Merchant
from acme._people import Person as Person
