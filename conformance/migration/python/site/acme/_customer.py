from decimal import Decimal
from typing import Any, List, Literal, Optional

from typing_extensions import TypedDict

CustomerStatus = Literal["active", "inactive"]


class Address:
    line1: str
    line2: Optional[str]
    postal_code: str
    city: str


class Card:
    id: str
    brand: str
    last4: str
    fingerprint: str


class CustomerBase:
    """What every object about a person carries."""

    id: str
    email: str

    # Readable by key too, as stripe-python's objects are dictionaries.
    def __getitem__(self, key: str) -> Any: ...


class Customer(CustomerBase):
    object: Literal["customer"]
    nickname: str
    fax: Optional[str]
    created: int
    """Seconds since the epoch."""
    status: CustomerStatus
    balance: Decimal
    """In major units."""
    phone: str
    address: Address
    cards: List[Card]


class Merchant:
    id: str
    nickname: str


class AddressParams(TypedDict, total=False):
    line1: str
    line2: Optional[str]
    postal_code: str
    city: str


class CustomerCreateParams(TypedDict, total=False):
    email: str
    nickname: str
    fax: str
    status: CustomerStatus
    balance: Decimal
    phone: str
    address: AddressParams
