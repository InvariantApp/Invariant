# A request field the API no longer accepts.
import acme

client = acme.Client("sk_test")


def sign_up(email: str, fax_number: str) -> acme.Customer:
    return client.customers.create(email=email, fax=fax_number)  # <- flag
