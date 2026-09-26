# The consumer's own wrapper over the SDK, handed a function that reads the
# renamed field.
from typing import Callable, TypeVar

import acme

client = acme.Client("sk_test")

T = TypeVar("T")


def with_customer(id: str, read: Callable[[acme.Customer], T]) -> T:
    return read(client.customers.retrieve(id))


def name_of(id: str) -> str:
    return with_customer(id, lambda customer: customer.nickname)
