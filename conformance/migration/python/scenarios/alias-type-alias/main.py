# The SDK's class named through the consumer's own alias.
from typing_extensions import TypeAlias

import acme

Account: TypeAlias = acme.Customer


def label(account: Account) -> str:
    return account.nickname
