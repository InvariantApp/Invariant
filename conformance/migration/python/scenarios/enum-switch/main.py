# A renamed enum value as a case of a match over the response's field.
import acme


def badge(customer: acme.Customer) -> str:
    match customer.status:
        case "active":
            return "Live"
        case "inactive":
            return "Paused"
