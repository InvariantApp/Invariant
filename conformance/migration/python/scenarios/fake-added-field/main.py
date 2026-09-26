# A test's stand-in for a response, built as the SDK's class, lacking a
# field the response now has.
import acme


def fake_customer() -> acme.Customer:
    customer = acme.Customer()  # <- flag
    customer.id = "cus_1"
    customer.nickname = "Ada"
    return customer
