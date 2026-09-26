# A test's stand-in for a response, built as the SDK's class, holding the
# renamed field.
import acme


def fake_customer() -> acme.Customer:
    customer = acme.Customer()
    customer.id = "cus_1"
    customer.nickname = "Ada"
    return customer
