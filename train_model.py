"""Train a simple electricity-consumption regression model."""

from __future__ import annotations

import json
from pathlib import Path

import joblib
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LinearRegression, Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GridSearchCV, KFold, cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler


# Step 1: Project settings
PROJECT_DIR = Path(__file__).resolve().parent
DATASET_PATH = PROJECT_DIR / "data" / "electricity_bill_prediction.csv"
MODEL_PATH = PROJECT_DIR / "models" / "electricity_usage_model.joblib"
RESULTS_DIR = PROJECT_DIR / "results"

RANDOM_STATE = 91
TARGET = "Monthly_Usage_kWh"

NUMERIC_FEATURES = [
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
]
CATEGORICAL_FEATURES = ["Area_Type"]
FEATURES = NUMERIC_FEATURES + CATEGORICAL_FEATURES


# Step 2: Load and clean the dataset
if not DATASET_PATH.exists():
    raise FileNotFoundError(
        f"Dataset not found at {DATASET_PATH}. "
        "Download the Kaggle CSV into the project's data folder."
    )

df = pd.read_csv(DATASET_PATH)
df.columns = df.columns.str.strip()

required_columns = FEATURES + [TARGET]
missing_columns = [column for column in required_columns if column not in df.columns]
if missing_columns:
    raise ValueError(f"Required dataset columns are missing: {missing_columns}")

original_rows = len(df)
duplicate_rows = int(df.duplicated().sum())
missing_values_before = int(df[required_columns].isna().sum().sum())

df = df.drop_duplicates().copy()
for column in NUMERIC_FEATURES + [TARGET]:
    df[column] = pd.to_numeric(df[column], errors="coerce")

# Rows without the value we want to predict cannot be used for supervised training.
df = df.dropna(subset=[TARGET]).copy()

X = df[FEATURES].copy()
y = df[TARGET].astype(float)

print("DATASET CLEANING")
print("Rows loaded:", original_rows)
print("Duplicate rows removed:", duplicate_rows)
print("Rows used for training:", len(df))
print("Missing feature values (imputed in the pipeline):", int(X.isna().sum().sum()))
print("Target:", TARGET)
print("Features:", ", ".join(FEATURES))
print("Other fields such as customer ID, location, and BDT bill columns are not used.")


# Step 3: Split training and testing data
X_train, X_test, y_train, y_test = train_test_split(
    X,
    y,
    test_size=0.2,
    random_state=RANDOM_STATE,
)


# Step 4: Prepare numerical and categorical features
numeric_preprocessing = Pipeline(
    steps=[
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
    ]
)

categorical_preprocessing = Pipeline(
    steps=[
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("one_hot", OneHotEncoder(handle_unknown="ignore")),
    ]
)

preprocessor = ColumnTransformer(
    transformers=[
        ("numbers", numeric_preprocessing, NUMERIC_FEATURES),
        ("categories", categorical_preprocessing, CATEGORICAL_FEATURES),
    ]
)


# Step 5: Train a Linear Regression model
linear_model = Pipeline(
    steps=[
        ("preprocessing", preprocessor),
        ("regression", LinearRegression()),
    ]
)

cross_validation = KFold(n_splits=5, shuffle=True, random_state=RANDOM_STATE)
linear_cv_scores = cross_val_score(
    linear_model,
    X_train,
    y_train,
    cv=cross_validation,
    scoring="neg_mean_absolute_error",
)
linear_cv_mae = float(-linear_cv_scores.mean())
linear_cv_mae_std = float((-linear_cv_scores).std(ddof=1))


# Step 6: Optimize the linear model with Ridge regularization
ridge_pipeline = Pipeline(
    steps=[
        ("preprocessing", preprocessor),
        ("regression", Ridge()),
    ]
)

ridge_search = GridSearchCV(
    estimator=ridge_pipeline,
    param_grid={"regression__alpha": [0.1, 1.0, 10.0, 100.0]},
    cv=cross_validation,
    scoring="neg_mean_absolute_error",
    n_jobs=-1,
)
ridge_search.fit(X_train, y_train)
ridge_cv_mae = float(-ridge_search.best_score_)
ridge_alpha_results = [
    {
        "alpha": float(params["regression__alpha"]),
        "mean_cv_mae_kwh": round(float(-mean_score), 4),
        "std_cv_mae_kwh": round(float(std_score), 4),
        "rank": int(rank),
    }
    for params, mean_score, std_score, rank in zip(
        ridge_search.cv_results_["params"],
        ridge_search.cv_results_["mean_test_score"],
        ridge_search.cv_results_["std_test_score"],
        ridge_search.cv_results_["rank_test_score"],
    )
]

# Pick the model using training cross-validation only; keep the test set for evaluation.
if linear_cv_mae <= ridge_cv_mae:
    best_model = linear_model.fit(X_train, y_train)
    best_model_name = "Linear Regression"
    best_cv_mae = linear_cv_mae
    best_alpha = None
else:
    best_model = ridge_search.best_estimator_
    best_model_name = "Ridge Regression"
    best_cv_mae = ridge_cv_mae
    best_alpha = float(ridge_search.best_params_["regression__alpha"])


# Step 7: Evaluate both models on the held-out test data
comparison_models = {
    "Linear Regression": linear_model.fit(X_train, y_train),
    "Optimized Ridge": ridge_search.best_estimator_,
}

comparison_rows = []
for model_name, model in comparison_models.items():
    predictions = model.predict(X_test)
    comparison_rows.append(
        {
            "Model": model_name,
            "MAE_kWh": float(mean_absolute_error(y_test, predictions)),
            "RMSE_kWh": float(np.sqrt(mean_squared_error(y_test, predictions))),
            "R2": float(r2_score(y_test, predictions)),
        }
    )

comparison = pd.DataFrame(comparison_rows)
best_predictions = best_model.predict(X_test)
test_mae = float(mean_absolute_error(y_test, best_predictions))
test_rmse = float(np.sqrt(mean_squared_error(y_test, best_predictions)))
test_r2 = float(r2_score(y_test, best_predictions))
test_actual = y_test.to_numpy(dtype=float)
test_residuals = test_actual - best_predictions
absolute_errors = np.abs(test_residuals)
test_mean_usage = float(np.mean(test_actual))

# Measure first-visit behavior separately: the UI allows a new account to leave
# previous-month usage blank, so mask that field for every held-out example.
X_test_cold_start = X_test.copy()
X_test_cold_start["Previous_Month_Usage_kWh"] = np.nan
cold_start_predictions = best_model.predict(X_test_cold_start)
cold_start_mae = float(mean_absolute_error(y_test, cold_start_predictions))
cold_start_rmse = float(np.sqrt(mean_squared_error(y_test, cold_start_predictions)))
cold_start_r2 = float(r2_score(y_test, cold_start_predictions))

usage_bands = pd.qcut(test_actual, q=4, labels=False, duplicates="drop") + 1
error_by_usage_band = pd.DataFrame(
    {
        "Usage_Quartile": usage_bands,
        "Actual_Usage_kWh": test_actual,
        "Predicted_Usage_kWh": best_predictions,
        "Error_kWh": test_residuals,
        "Absolute_Error_kWh": absolute_errors,
    }
).groupby("Usage_Quartile", as_index=False).agg(
    Test_Rows=("Actual_Usage_kWh", "size"),
    Minimum_Actual_kWh=("Actual_Usage_kWh", "min"),
    Maximum_Actual_kWh=("Actual_Usage_kWh", "max"),
    Mean_Actual_kWh=("Actual_Usage_kWh", "mean"),
    Mean_Predicted_kWh=("Predicted_Usage_kWh", "mean"),
    MAE_kWh=("Absolute_Error_kWh", "mean"),
    Mean_Signed_Error_kWh=("Error_kWh", "mean"),
)

print("\nCROSS-VALIDATION MAE (training set)")
print("Linear Regression:", round(linear_cv_mae, 2), "kWh")
print("Optimized Ridge:", round(ridge_cv_mae, 2), "kWh")
print("Chosen model:", best_model_name)
if best_alpha is not None:
    print("Best Ridge alpha:", best_alpha)

print("\nHELD-OUT TEST PERFORMANCE")
print(comparison.round(3).to_string(index=False))
print("\nSelected model MAE:", round(test_mae, 2), "kWh")
print("Selected model RMSE:", round(test_rmse, 2), "kWh")
print("Selected model R2:", round(test_r2, 3))
print("Mean signed error:", round(float(test_residuals.mean()), 2), "kWh")
print("90th percentile absolute error:", round(float(np.quantile(absolute_errors, 0.9)), 2), "kWh")


# Step 8: Save the trained model and result files
MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

joblib.dump(best_model, MODEL_PATH)

metrics = {
    "problem": "Predict monthly household electricity usage in kWh",
    "target": TARGET,
    "dataset_rows_loaded": int(original_rows),
    "dataset_rows_used": int(len(df)),
    "duplicate_rows_removed": duplicate_rows,
    "missing_values_before_imputation": missing_values_before,
    "train_rows": int(len(X_train)),
    "test_rows": int(len(X_test)),
    "selected_model": best_model_name,
    "ridge_alpha": best_alpha,
    "training_cross_validation_mae_kwh": round(best_cv_mae, 3),
    "linear_regression_cross_validation_mae_kwh": round(linear_cv_mae, 4),
    "linear_regression_cross_validation_mae_std_kwh": round(linear_cv_mae_std, 4),
    "ridge_alpha_cross_validation_results": ridge_alpha_results,
    "test_mae_kwh": round(test_mae, 3),
    "test_rmse_kwh": round(test_rmse, 3),
    "test_r2": round(test_r2, 4),
    "test_mean_actual_usage_kwh": round(test_mean_usage, 3),
    "test_mean_signed_error_kwh": round(float(test_residuals.mean()), 3),
    "test_median_signed_error_kwh": round(float(np.median(test_residuals)), 3),
    "test_p90_absolute_error_kwh": round(float(np.quantile(absolute_errors, 0.9)), 3),
    "test_max_absolute_error_kwh": round(float(absolute_errors.max()), 3),
    "test_within_10_kwh_pct": round(float(np.mean(absolute_errors <= 10) * 100), 2),
    "test_within_20_kwh_pct": round(float(np.mean(absolute_errors <= 20) * 100), 2),
    "test_within_30_kwh_pct": round(float(np.mean(absolute_errors <= 30) * 100), 2),
    "cold_start_evaluation": {
        "scenario": "Previous month usage withheld for every held-out household",
        "imputation": "Training-set median from the fitted preprocessing pipeline",
        "test_mae_kwh": round(cold_start_mae, 3),
        "test_rmse_kwh": round(cold_start_rmse, 3),
        "test_r2": round(cold_start_r2, 4),
    },
    "model_comparison": comparison.round(4).to_dict(orient="records"),
}

with (RESULTS_DIR / "metrics.json").open("w", encoding="utf-8") as file:
    json.dump(metrics, file, indent=2)

prediction_results = pd.DataFrame(
    {
        "Actual_Usage_kWh": y_test.to_numpy(),
        "Predicted_Usage_kWh": best_predictions,
    }
)
prediction_results["Error_kWh"] = (
    prediction_results["Actual_Usage_kWh"]
    - prediction_results["Predicted_Usage_kWh"]
)
prediction_results.to_csv(RESULTS_DIR / "test_predictions.csv", index=False)
error_by_usage_band.round(4).to_csv(RESULTS_DIR / "error_by_usage_band.csv", index=False)
pd.DataFrame(
    {
        "Actual_Usage_kWh": y_test.to_numpy(),
        "Predicted_Usage_kWh": cold_start_predictions,
        "Error_kWh": y_test.to_numpy() - cold_start_predictions,
    }
).to_csv(RESULTS_DIR / "cold_start_test_predictions.csv", index=False)

feature_names = best_model.named_steps["preprocessing"].get_feature_names_out()
coefficients = best_model.named_steps["regression"].coef_
coefficient_table = pd.DataFrame(
    {
        "Feature": feature_names,
        "Coefficient": coefficients,
    }
)
coefficient_table["Absolute_Coefficient"] = coefficient_table["Coefficient"].abs()
coefficient_table.sort_values(
    "Absolute_Coefficient", ascending=False
).to_csv(RESULTS_DIR / "model_coefficients.csv", index=False)

chart_min = min(float(y_test.min()), float(best_predictions.min()))
chart_max = max(float(y_test.max()), float(best_predictions.max()))
plt.figure(figsize=(8, 6))
plt.scatter(y_test, best_predictions, alpha=0.7, color="teal")
plt.plot([chart_min, chart_max], [chart_min, chart_max], "r--", label="Perfect prediction")
plt.xlabel("Actual monthly usage (kWh)")
plt.ylabel("Predicted monthly usage (kWh)")
plt.title(f"Actual vs Predicted Usage — {best_model_name}")
plt.legend()
plt.tight_layout()
plt.savefig(RESULTS_DIR / "actual_vs_predicted.png", dpi=150)
plt.close()

fig, axes = plt.subplots(1, 2, figsize=(12, 4.8))
axes[0].scatter(best_predictions, test_residuals, alpha=0.7, color="teal")
axes[0].axhline(0, color="firebrick", linestyle="--", linewidth=1.5)
axes[0].set_xlabel("Predicted monthly usage (kWh)")
axes[0].set_ylabel("Residual (actual − predicted, kWh)")
axes[0].set_title("Residuals vs predicted usage")
axes[1].hist(test_residuals, bins=18, color="steelblue", edgecolor="white")
axes[1].axvline(0, color="firebrick", linestyle="--", linewidth=1.5)
axes[1].set_xlabel("Residual (actual − predicted, kWh)")
axes[1].set_ylabel("Number of test households")
axes[1].set_title("Held-out residual distribution")
fig.suptitle(f"Error diagnostics — {best_model_name}")
fig.tight_layout()
fig.savefig(RESULTS_DIR / "residual_diagnostics.png", dpi=150)
plt.close(fig)

print("\nSaved model:", MODEL_PATH)
print("Saved evaluation results:", RESULTS_DIR)
