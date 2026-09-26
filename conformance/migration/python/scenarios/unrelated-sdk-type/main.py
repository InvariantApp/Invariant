# Another of the SDK's classes, which no Change touches, has a field of the
# same name.
import acme

client = acme.Client("sk_test")


def merchant_name(id: str) -> str:
    merchant = client.merchants.retrieve(id)
    return merchant.nickname
