# An amount now in minor units, read where the SDK exports an exact conversion.
from decimal import Decimal

import acme

client = acme.Client("sk_test")


def owed(id: str) -> Decimal:
    customer = client.customers.retrieve(id)
    return customer.balance
