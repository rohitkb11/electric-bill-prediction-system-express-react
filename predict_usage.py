"""Read model inputs from stdin and return one monthly kWh estimate as JSON."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import joblib
import pandas as pd


PROJECT_DIR = Path(__file__).resolve().parent
MODEL_PATH = PROJECT_DIR / "models" / "electricity_usage_model.joblib"
FEATURES = [
    "Household_Size",
    "Rooms",
    "AC_Units",
    "Fan_Count",
    "Light_Count",
    "Refrigerator",
    "TV_Count",
    "Washing_Machine",
    "Other_Appliances",
    "Previous_Month_Usage_kWh",
    "Temperature_C",
    "Area_Type",
]


def main() -> None:
    data = json.load(sys.stdin)
    if not MODEL_PATH.exists():
        raise FileNotFoundError("The trained model is missing. Run train_model.py first.")
    model = joblib.load(MODEL_PATH)
    row = pd.DataFrame([{name: data.get(name) for name in FEATURES}], columns=FEATURES)
    predicted_kwh = max(0.0, float(model.predict(row)[0]))
    print(json.dumps({"predicted_kwh": predicted_kwh}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
