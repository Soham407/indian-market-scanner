#!/usr/bin/env python3
"""Fetch live Angel One option Greeks for a given contract expiry."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any


@dataclass(frozen=True)
class AngelOneConfig:
    api_key: str
    client_code: str
    pin: str
    totp_secret: str


def load_config() -> AngelOneConfig:
    values = {
        "ANGEL_ONE_API_KEY": os.environ.get("ANGEL_ONE_API_KEY", ""),
        "ANGEL_ONE_CLIENT_CODE": os.environ.get("ANGEL_ONE_CLIENT_CODE", ""),
        "ANGEL_ONE_PIN": os.environ.get("ANGEL_ONE_PIN", ""),
        "ANGEL_ONE_TOTP_SECRET": os.environ.get("ANGEL_ONE_TOTP_SECRET", ""),
    }
    missing = [name for name, value in values.items() if not value.strip()]
    if missing:
        raise ValueError(
            "Set the required Angel One environment variables before running: "
            f"{', '.join(missing)}"
        )
    return AngelOneConfig(
        api_key=values["ANGEL_ONE_API_KEY"],
        client_code=values["ANGEL_ONE_CLIENT_CODE"],
        pin=values["ANGEL_ONE_PIN"],
        totp_secret=values["ANGEL_ONE_TOTP_SECRET"],
    )


def default_weekly_expiry(today: date | None = None) -> date:
    """Return the next Thursday on or after `today`.

    Angel One's weekly NSE option expiry is typically Thursday. The caller can
    still override this via `--expirydate` when a holiday shifts the expiry.
    """

    current_day = today or date.today()
    days_until_thursday = (3 - current_day.weekday()) % 7
    return current_day + timedelta(days=days_until_thursday)


def _coerce_expiry_date(expiry: str | date | datetime) -> date:
    if isinstance(expiry, datetime):
        return expiry.date()
    if isinstance(expiry, date):
        return expiry

    text = expiry.strip()
    for fmt in ("%d%b%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError(
        "expirydate must be provided as DDMMMYYYY (for example 04JUN2026) or YYYY-MM-DD"
    )


def format_expiry_date(expiry: str | date | datetime) -> str:
    return _coerce_expiry_date(expiry).strftime("%d%b%Y").upper()


def build_option_greek_params(name: str, expiry: str | date | datetime) -> dict[str, str]:
    return {
        "name": name,
        "expirydate": format_expiry_date(expiry),
    }


def create_session(config: AngelOneConfig):
    try:
        import pyotp
        from SmartApi.smartConnect import SmartConnect
    except ModuleNotFoundError as exc:
        raise RuntimeError(
            "Missing Python dependency for Angel One login. "
            "Install pyotp and the SmartAPI package before running this script."
        ) from exc

    smart_api = SmartConnect(api_key=config.api_key)
    totp_value = pyotp.TOTP(config.totp_secret).now()

    try:
        session = smart_api.generateSession(config.client_code, config.pin, totp_value)
    except Exception as exc:
        raise RuntimeError(f"Session failed to generate: {exc}") from exc

    if not session or not session.get("status"):
        message = session.get("message") if isinstance(session, dict) else session
        raise RuntimeError(f"Session failed to generate: {message}")

    return smart_api


def fetch_option_greeks(smart_api: Any, name: str, expiry: str | date | datetime) -> Any:
    params = build_option_greek_params(name, expiry)
    return smart_api.optionGreek(params)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch live option Greeks from Angel One SmartAPI."
    )
    parser.add_argument(
        "--name",
        default="NIFTY",
        help="Underlying name for the Greeks request. Default: NIFTY.",
    )
    parser.add_argument(
        "--expirydate",
        help=(
            "Expiry date in DDMMMYYYY or YYYY-MM-DD format. "
            "If omitted, the next Thursday is used."
        ),
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config: AngelOneConfig | None = None
    smart_api: Any | None = None

    try:
        config = load_config()
        smart_api = create_session(config)
        expiry = _coerce_expiry_date(args.expirydate) if args.expirydate else default_weekly_expiry()
        params = build_option_greek_params(args.name, expiry)

        print(f"Fetching live Greeks for {params['name']} expiring {params['expirydate']}...")
        response = fetch_option_greeks(smart_api, args.name, expiry)

        if response and response.get("status"):
            print(json.dumps(response.get("data"), indent=4))
            return 0

        print("API returned an error or empty data:", response)
        return 1
    except Exception as exc:
        print(f"Error fetching Greeks: {exc}")
        return 1
    finally:
        if smart_api is not None and config is not None:
            try:
                smart_api.terminateSession(config.client_code)
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
