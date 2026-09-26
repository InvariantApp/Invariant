# A request amount now sent in minor units, written as a literal.
from decimal import Decimal

import acme

client = acme.Client("sk_test")


def sign_up(email: str) -> acme.Customer:
    return client.customers.create(email=email, balance=Decimal("12.50"))
