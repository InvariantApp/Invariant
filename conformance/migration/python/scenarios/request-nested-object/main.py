# A renamed field of a nested object, written inside a request.
import acme

client = acme.Client("sk_test")


def sign_up(email: str, line1: str, city: str, zip_code: str) -> acme.Customer:
    return client.customers.create(
        email=email,
        address={"line1": line1, "postal_code": zip_code, "city": city},
    )
