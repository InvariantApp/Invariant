# A response object's removed field, read directly.
from typing import Optional

import acme

client = acme.Client("sk_test")


def fax_of(id: str) -> Optional[str]:
    customer = client.customers.retrieve(id)
    return customer.fax  # <- flag
