# The response's status shares the request's value type, and only the
# request's values were renamed.
import acme


def is_live(customer: acme.Customer) -> bool:
    return customer.status == "active"
