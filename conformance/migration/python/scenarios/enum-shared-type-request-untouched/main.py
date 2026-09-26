# The request's status shares the response's value type, and only the
# response's values were renamed.
import acme

client = acme.Client("sk_test")


def sign_up(email: str) -> acme.Customer:
    return client.customers.create(email=email, status="active")
