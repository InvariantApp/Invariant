# The SDK's client and class imported under other names.
from acme import Client as Api
from acme import Customer as Account

api = Api("sk_test")


def label(account: Account) -> str:
    return account.nickname


def show(id: str) -> str:
    return label(api.customers.retrieve(id))
