# The consumer's own class extends the SDK's.
import acme


class Account(acme.Customer):
    plan: str

    def label(self) -> str:
        return self.nickname
