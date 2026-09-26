# The renamed field matched by a class pattern into a local of another name.
import acme


def zip_of(customer: acme.Customer) -> str:
    match customer.address:
        case acme.Address(postal_code=zip_code, city=city):
            return f"{zip_code} {city}"
    return ""
