from __future__ import annotations

import os
import unittest
from datetime import date, datetime
from unittest.mock import patch

import live_greeks


class AngelOneConfigTests(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_load_config_rejects_missing_environment_variables(self) -> None:
        with self.assertRaisesRegex(ValueError, "ANGEL_ONE_API_KEY"):
            live_greeks.load_config()

    @patch.dict(
        os.environ,
        {
            "ANGEL_ONE_API_KEY": "api-key",
            "ANGEL_ONE_CLIENT_CODE": "client-code",
            "ANGEL_ONE_PIN": "pin",
            "ANGEL_ONE_TOTP_SECRET": "totp-secret",
        },
        clear=True,
    )
    def test_load_config_reads_environment_variables(self) -> None:
        config = live_greeks.load_config()

        self.assertEqual(config.api_key, "api-key")
        self.assertEqual(config.client_code, "client-code")
        self.assertEqual(config.pin, "pin")
        self.assertEqual(config.totp_secret, "totp-secret")


class ExpiryFormattingTests(unittest.TestCase):
    def test_format_expiry_date_uses_angel_one_format(self) -> None:
        self.assertEqual(
            live_greeks.format_expiry_date(date(2026, 6, 4)),
            "04JUN2026",
        )

    def test_build_option_greek_params_normalizes_datetime(self) -> None:
        params = live_greeks.build_option_greek_params("NIFTY", datetime(2026, 6, 4, 10, 24))

        self.assertEqual(params, {"name": "NIFTY", "expirydate": "04JUN2026"})


class DefaultExpiryTests(unittest.TestCase):
    def test_default_expiry_date_picks_next_thursday(self) -> None:
        self.assertEqual(live_greeks.default_weekly_expiry(date(2026, 6, 1)), date(2026, 6, 4))


if __name__ == "__main__":
    unittest.main()
