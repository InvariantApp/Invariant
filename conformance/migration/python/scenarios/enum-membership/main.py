# A renamed enum value in a tuple the response's field is tested against.
import acme


def billable(customer: acme.Customer) -> bool:
    return customer.status in ("active", "past_due")
