from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Municipality, User
from .security import hash_password


def bootstrap(db: Session) -> None:
    user_exists = db.execute(select(User).where(User.username == "admin")).scalar_one_or_none()
    if not user_exists:
        db.add(
            User(
                username="admin",
                hashed_password=hash_password("admin"),
                role="admin",
                must_change_password=True,
            )
        )

    for name in ["Grenoble", "Vienne", "Voiron", "Bourgoin-Jallieu"]:
        exists = db.execute(select(Municipality).where(Municipality.name == name)).scalar_one_or_none()
        if not exists:
            db.add(Municipality(name=name, crisis_mode=False))

    db.commit()
