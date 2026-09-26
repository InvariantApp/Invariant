# The consumer's own class has a status compared with the old value's spelling.
from dataclasses import dataclass

import acme


@dataclass
class Order:
    status: str
    customer: acme.Customer


def is_open(order: Order) -> bool:
    return order.status == "active" and order.customer.id != ""
