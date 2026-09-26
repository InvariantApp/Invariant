# A field the response's nested object lost.
from typing import Optional

import acme


def second_line(customer: acme.Customer) -> Optional[str]:
    return customer.address.line2  # <- flag
