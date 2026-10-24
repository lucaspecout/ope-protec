"""Upgrade contracts: existing logins, JWTs and PostgreSQL connection URLs."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from jose import jwt
from app import security
from app.database import database_url_with_driver


class DependencyCompatibilityTests(unittest.TestCase):
    # Generated using the previous Passlib 1.7.4 / bcrypt 4.0.1 stack.
    LEGACY_10 = "$2b$10$abcdefghijklmnopqrstuubGIKzcEX7yWRRn7oqTrrxxjIYuAGa5S"
    LEGACY_UNICODE = "$2b$08$abcdefghijklmnopqrstuuRVTN38FKt7Gzr8RoOVVrD7z4IJgASJ2"
    LEGACY_2A = "$2a$08$abcdefghijklmnopqrstuuP4RE.bfbQiWlWAvhQTpGtDbn5.PxCRS"

    def test_existing_passwords_and_cost_policy_are_preserved(self):
        self.assertTrue(security.verify_password("mot-de-passe-test", self.LEGACY_10))
        self.assertTrue(security.verify_password("mot-de-passe-test", self.LEGACY_2A))
        self.assertTrue(security.verify_password("mot-de-passe-test", self.LEGACY_2A.replace("$2a$", "$2y$")))
        ok, updated = security.verify_and_upgrade("mot-de-passe-test", self.LEGACY_10)
        self.assertTrue(ok)
        self.assertTrue(updated.startswith("$2b$08$"))
        self.assertTrue(security.verify_password("mot-de-passe-test", updated))
        self.assertEqual(security.verify_and_upgrade("mot-de-passe-test", updated), (True, None))

    def test_legacy_utf8_truncation_still_verifies_with_bcrypt_5(self):
        self.assertTrue(security.verify_password("é" * 40, self.LEGACY_UNICODE))
        self.assertTrue(security.verify_password("é" * 40, security.hash_password("é" * 40)))

    def test_wrong_invalid_and_null_passwords_are_rejected(self):
        self.assertFalse(security.verify_password("incorrect", self.LEGACY_10))
        self.assertEqual(security.verify_and_upgrade("incorrect", self.LEGACY_10), (False, None))
        self.assertFalse(security.verify_password("test", "invalid hash"))
        self.assertFalse(security.verify_password("test\x00", self.LEGACY_10))
        with self.assertRaises(ValueError):
            security.hash_password("test\x00")

    def test_tokens_remain_hs256_and_keep_their_subject(self):
        token = security.create_access_token("utilisateur-test")
        payload = jwt.decode(token, security.settings.secret_key, algorithms=["HS256"])
        self.assertEqual(payload["sub"], "utilisateur-test")
        self.assertIn("exp", payload)

    def test_bare_postgresql_urls_keep_psycopg2_and_encoded_credentials(self):
        value = "postgresql://user:p%40ss%3Aword@db:5432/veille?sslmode=require"
        url = database_url_with_driver(value)
        self.assertEqual(url.drivername, "postgresql+psycopg2")
        self.assertEqual(url.password, "p@ss:word")
        self.assertEqual(url.query["sslmode"], "require")
        for driver in ("postgresql+psycopg2", "postgresql+psycopg"):
            self.assertEqual(database_url_with_driver(f"{driver}://user@db/veille").drivername, driver)
        self.assertEqual(database_url_with_driver("sqlite://").drivername, "sqlite")


if __name__ == "__main__":
    unittest.main()
