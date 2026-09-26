# A renamed enum value compared with the response's field as plain text.
import acme


def is_live(customer: acme.Customer) -> bool:
    return str(customer.status) == "active"
