# A copy of the response with the renamed field overridden.
import copy

import acme


def renamed(customer: acme.Customer, name: str) -> acme.Customer:
    changed = copy.copy(customer)
    changed.nickname = name
    return changed
