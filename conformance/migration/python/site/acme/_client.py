from typing import List

from typing_extensions import Unpack

from acme._customer import Customer, CustomerCreateParams, Merchant
from acme._people import Person


class CustomersResource:
    def retrieve(self, id: str) -> Customer: ...

    def create(self, **params: Unpack[CustomerCreateParams]) -> Customer: ...

    def list(self) -> List[Customer]: ...


class MerchantsResource:
    def retrieve(self, id: str) -> Merchant: ...


class PeopleResource:
    def retrieve(self, id: str) -> Person: ...


class Client:
    customers: CustomersResource
    merchants: MerchantsResource
    people: PeopleResource

    def __init__(self, api_key: str) -> None: ...
