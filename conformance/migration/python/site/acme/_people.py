# The same object as a hand-written client that names fields its own way
# declares it: a pydantic model whose fields alias the wire's names.
from pydantic import BaseModel, Field


class Person(BaseModel):
    id: str
    nick_name: str = Field(alias="nickname")
    email_address: str = Field(alias="email")
