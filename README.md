# Household Electricity Usage & Bill Prediction

A small AI/ML web application for estimating monthly household electricity use from family size, rooms, appliances, and related inputs. A **React** frontend calls an **Express** backend. The backend invokes a small Python script to load the trained scikit-learn model, then stores each signed-in user's estimate history in SQLite.

## Project requirements covered

- **Problem definition:** estimate monthly household electricity use in kWh, then estimate a bill using the user's per-unit tariff in Indian rupees.
- **Dataset collection:** Kaggle's [Electricity Bill Prediction dataset](https://www.kaggle.com/datasets/armanahmedtaief/electricity-bill-prediction), included in `data/electricity_bill_prediction.csv`.
- **Data preprocessing:** duplicate removal, numeric conversion, target cleanup, median/mode imputation, scaling, and one-hot encoding inside a scikit-learn pipeline.
- **Model development:** Linear Regression baseline compared with optimized Ridge Regression.
- **Performance evaluation:** 80:20 train/test split, five-fold cross-validation on the training portion, MAE, RMSE, and R².
- **Model optimization:** Ridge alpha selection using training-only cross-validation.
- **Result analysis:** saved metrics, test predictions, model coefficients, and an actual-versus-predicted chart.
- **Frontend and backend:** React household form, Express API, password-hash authentication, private per-user prediction history, and a responsive dashboard.

## Dataset limitation

The selected Kaggle dataset contains household records described as Bangladesh data, and its page does not clearly document the records' provenance. This is a classroom prototype, not a model validated on representative Indian households. The app predicts kWh and applies the user's INR tariff as `predicted kWh × tariff`. Utility slabs, fixed charges, taxes, and subsidies are not included.

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

The backend creates `instance/electricity_app.sqlite3` on first run. It stores accounts, sessions, and prediction history there. Each account's history is filtered by that account's user ID. Returning users see their latest predicted usage prefilled as an editable starting value for previous-month usage.

If the Python command on your system is named differently, set `PYTHON_EXECUTABLE` to the interpreter that has the requirements installed. For example:

```powershell
$env:PYTHON_EXECUTABLE = "C:\Path\To\Python\python.exe"
```

## Production build

Build the React frontend and start Express to serve both the built frontend and API:

```powershell
npm run build
$env:NODE_ENV = "production"
$env:SESSION_SECRET = "use-a-unique-long-random-secret"
npm start
```

Production needs HTTPS so session cookies are marked secure. The server listens on all interfaces in production by default; set `HOST` if your hosting platform requires a different binding. The local SQLite database is ignored by Git and remains on the computer running the app. This simple authentication setup is intended for a local coursework demonstration; use an appropriate hosted database and deployment security configuration for a public service.

## Train or inspect the model

```powershell
python train_model.py
```

This creates or updates:

- `models/electricity_usage_model.joblib` — preprocessing plus the selected fitted regression model.
- `results/metrics.json` — row counts, selected model, and held-out metrics.
- `results/test_predictions.csv` — actual and predicted test usage.
- `results/model_coefficients.csv` — fitted model coefficients.
- `results/actual_vs_predicted.png` — evaluation plot.

The Express server calls `predict_usage.py` for each estimate. That script loads the saved model and returns the predicted kWh as JSON; Express calculates the bill and saves both the estimate and household inputs to the user's history.
