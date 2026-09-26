# A renamed field of a nested object, read through the response.
import acme


def zip_of(customer: acme.Customer) -> str:
    return customer.address.postal_code
