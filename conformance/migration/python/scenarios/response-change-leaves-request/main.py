# The response's field is renamed; the request body's field of the same
# name is not, and is what this writes.
import acme

client = acme.Client("sk_test")


def sign_up(email: str, name: str) -> acme.Customer:
    return client.customers.create(email=email, nickname=name)
