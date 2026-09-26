# The consumer's own class has a field of the same name.
from dataclasses import dataclass

import acme

client = acme.Client("sk_test")


@dataclass
class Profile:
    nickname: str


def greet(profile: Profile) -> str:
    return profile.nickname


def profile_of(id: str) -> Profile:
    customer = client.customers.retrieve(id)
    return Profile(nickname=customer.id)
