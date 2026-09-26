# A request amount now sent in minor units, written as a computed value.
from decimal import Decimal

import acme

client = acme.Client("sk_test")


def sign_up(email: str, credit: Decimal) -> acme.Customer:
    return client.customers.create(email=email, balance=credit * 2)
