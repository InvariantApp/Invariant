# A renamed enum value sent in a request.
import acme

client = acme.Client("sk_test")


def sign_up(email: str) -> acme.Customer:
    return client.customers.create(email=email, status="active")
