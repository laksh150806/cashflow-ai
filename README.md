# CashFlow AI

> AI-powered UPI cash flow analytics with Holt-Winters forecasting and real-time outlier detection.

## Project Structure

```
cashflow-ai/
├── 📄 index.html            # Frontend dashboard (open in browser)
├── 🎨 styles.css            # Premium dark glassmorphic UI
├── ⚙️  app.js               # Dashboard controller (Chart.js)
├── 🧮 forecasting.js        # Holt-Winters + outlier detection engine
│
├── 🗄️  daily_cashflow_data.json   # Pre-processed time-series (aggregated from CSV)
├── 🐍 prep_data.py          # Data prep script (Python, run once)
│
├── 🔧 main.py               # FastAPI backend — business & transaction API
├── 🗃️  models.py             # SQLAlchemy ORM models
├── 💾 database.py           # DB engine & session factory
├── 📦 requirements.txt      # Python dependencies
│
└── upi_transactions_2024.csv  # Raw dataset (250K UPI transactions, 2024)
```

## Frontend (No build needed)

Serve the folder with any static server and open `index.html`:

```bash
# Python (quick)
python -m http.server 8080

# Node.js
npx serve .
```

Then open **http://localhost:8080**

### Features
- **Holt-Winters Triple Exponential Smoothing** — α (level), β (trend), γ (seasonal) sliders
- **30 / 60 / 90-day forecast horizons** with ±15% confidence bands
- **14-day moving σ outlier detection** — adjustable threshold multiplier (k·σ)
- **Cohort filtering** — All India · By State · By Bank
- **Live metric cards** — Net Cash Flow, End Balance, Spike Count, Trend
- **3 interactive charts** — Balance + Forecast, Outflow + Outliers, Category Doughnut

## Backend (FastAPI)

```bash
pip install -r requirements.txt
uvicorn main:app --reload
```

API docs at **http://localhost:8000/docs**

## Data Preparation

To regenerate `daily_cashflow_data.json` from the raw CSV:

```bash
pip install pandas
python prep_data.py
```