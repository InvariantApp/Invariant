# Request parameters gathered in a dictionary, then unpacked into the SDK's call.
import acme

client = acme.Client("sk_test")


def sign_up(email: str, name: str) -> acme.Customer:
    params = {"email": email, "nickname": name}
    return client.customers.create(**params)
