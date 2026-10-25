# Household Electricity Usage & Bill Prediction

A small AI/ML web application for estimating monthly household electricity use from family size, rooms, appliances, and related inputs. A **React** frontend calls an **Express** backend. The backend invokes a small Python script to load the trained scikit-learn model, then stores each signed-in user's estimate history in SQLite.

## Project requirements covered

- **Problem definition:** estimate monthly household electricity use in kWh, then estimate a bill using the user's per-unit tariff.
- **Dataset collection:** Kaggle's [Electricity Bill Prediction dataset](https://www.kaggle.com/datasets/armanahmedtaief/electricity-bill-prediction), included in `data/electricity_bill_prediction.csv`.
- **Data preprocessing:** duplicate removal, numeric conversion, target cleanup, median/mode imputation, scaling, and one-hot encoding inside a scikit-learn pipeline.
- **Model development:** Linear Regression baseline compared with optimized Ridge Regression.
- **Performance evaluation:** 80:20 train/test split, five-fold cross-validation on the training portion, MAE, RMSE, and R², plus a held-out cold-start scenario with previous-month usage removed.
- **Model optimization:** Ridge alpha selection using training-only cross-validation.
- **Result analysis:** saved cross-validation search results, test predictions, residual summaries, errors by test-usage quartile, model coefficients, and diagnostic charts.
- **Frontend and backend:** React household form, Express API, password-hash authentication, private per-user prediction history, and a responsive dashboard.

## Run locally on Windows

Use Node.js 22.13 or newer and Python 3. From this project folder, open PowerShell:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python train_model.py
npm install
$env:SESSION_SECRET = "use-a-long-random-value-for-your-local-session"
npm run dev
```

Open the Vite address printed in the terminal (normally <http://127.0.0.1:5173>). The Express API runs on port 3000 and the Vite development server proxies `/api` calls to it. Create an account; a new account's history starts empty.

The backend creates `instance/electricity_app.sqlite3` on first run. It stores accounts and prediction history there. Each account sees only its own history. Sessions are kept in memory for this simple local demo, so signing in again may be needed after restarting the server. Returning users see their latest predicted usage prefilled as an editable starting value for previous-month usage.

If the Python command on your system is named differently, set `PYTHON_EXECUTABLE` to the interpreter that has the requirements installed. For example:

```powershell
$env:PYTHON_EXECUTABLE = "C:\Path\To\Python\python.exe"
```

## Build and start locally

To build React and have Express serve the frontend locally:

```powershell
npm run build
npm start
```

The SQLite database keeps accounts and prediction history between runs. For simplicity, sign-in sessions are held in memory and end when the server restarts.

## Train or inspect the model

```powershell
python train_model.py
```

This creates or updates:

- `models/electricity_usage_model.joblib` — preprocessing plus the selected fitted regression model.
- `results/metrics.json` — row counts, selected model, and held-out metrics.
- `results/test_predictions.csv` — actual and predicted test usage.
- `results/cold_start_test_predictions.csv` — held-out predictions when previous-month usage is unavailable, matching a first-visit estimate.
- `results/error_by_usage_band.csv` — held-out MAE and signed error across four actual-usage quartiles.
- `results/model_coefficients.csv` — fitted model coefficients.
- `results/actual_vs_predicted.png` — evaluation plot.
- `results/residual_diagnostics.png` — residual-versus-prediction plot and residual histogram.

`metrics.json` also records the five-fold alpha search scores, residual bias, the 90th-percentile absolute error, and the share of test estimates within 10, 20, and 30 kWh of the observed value.
The report lists cold-start results separately because previous-month usage is strongly predictive and may be unavailable for a new user. Headline metrics use the full feature set, while first-visit performance is summarized by the cold-start results.

The Express server calls `predict_usage.py` for each estimate. That script loads the saved model and returns the predicted kWh as JSON; Express calculates the bill and saves both the estimate and household inputs to the user's history.
