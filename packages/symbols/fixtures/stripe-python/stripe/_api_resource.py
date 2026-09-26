from stripe._stripe_object import StripeObject
from typing import ClassVar, Generic, TypeVar

T = TypeVar("T", bound=StripeObject)


class APIResource(StripeObject, Generic[T]):
    OBJECT_NAME: ClassVar[str]

    @classmethod
    def class_url(cls) -> str:
        base = cls.OBJECT_NAME.replace(".", "/")
        return "/v1/%ss" % (base,)
