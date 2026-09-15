from fastapi import FastAPI, Depends, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta
import pandas as pd
import io

from database import engine, get_db, Base
from models import Business, Transaction, CreditScore, CashFlowForecast, Alert

# Create all tables
Base.metadata.create_all(bind=engine)

app = FastAPI(title="CashFlow AI - Decision Engine")


@app.get("/")
def root():
    return FileResponse("index.html")


# ---------- BUSINESSES ----------

@app.post("/businesses")
def create_business(name: str, sector: str = None, db: Session = Depends(get_db)):
    business = Business(name=name, sector=sector)
    db.add(business)
    db.commit()
    db.refresh(business)
    return business


@app.get("/businesses")
def list_businesses(db: Session = Depends(get_db)):
    return db.query(Business).all()


# ---------- TRANSACTION UPLOAD ----------

@app.post("/businesses/{business_id}/transactions/upload")
async def upload_transactions(business_id: int, file: UploadFile = File(...), db: Session = Depends(get_db)):
    business = db.query(Business).filter(Business.id == business_id).first()
    if not business:
        raise HTTPException(status_code=404, detail="Business not found")

    contents = await file.read()
    df = pd.read_csv(io.BytesIO(contents))

    # Expecting columns: date, amount, type, category, balance_after
    for _, row in df.iterrows():
        txn = Transaction(
            business_id=business_id,
            date=pd.to_datetime(row["date"]),
            amount=float(row["amount"]),
            type=row["type"],
            category=row.get("category"),
            balance_after=row.get("balance_after")
        )
        db.add(txn)

    db.commit()
    return {"message": f"{len(df)} transactions uploaded for business {business_id}"}


# ---------- CREDIT SCORE (Decision Engine core logic) ----------

@app.get("/businesses/{business_id}/credit-score")
def get_credit_score(business_id: int, db: Session = Depends(get_db)):
    txns = db.query(Transaction).filter(Transaction.business_id == business_id).all()
    if not txns:
        raise HTTPException(status_code=404, detail="No transactions found for this business")

    inflows = [t.amount for t in txns if t.type == "inflow"]
    outflows = [t.amount for t in txns if t.type == "outflow"]

    total_inflow = sum(inflows) or 1
    total_outflow = sum(outflows) or 0
    outflow_ratio = total_outflow / total_inflow

    # simple volatility measure on inflow amounts
    if len(inflows) > 1:
        mean_inflow = sum(inflows) / len(inflows)
        variance = sum((x - mean_inflow) ** 2 for x in inflows) / len(inflows)
        volatility = (variance ** 0.5) / mean_inflow if mean_inflow else 0
    else:
        volatility = 0

    # simple scoring formula (weights can be tuned)
    score = 100
    score -= min(outflow_ratio * 40, 40)       # penalize high spend vs income
    score -= min(volatility * 30, 30)          # penalize unstable income
    score = max(0, min(100, round(score, 1)))

    risk_factors = {
        "outflow_to_inflow_ratio": round(outflow_ratio, 2),
        "income_volatility": round(volatility, 2),
        "total_transactions": len(txns)
    }

    record = CreditScore(business_id=business_id, score=score, risk_factors=risk_factors)
    db.add(record)
    db.commit()

    return {"business_id": business_id, "score": score, "risk_factors": risk_factors}


# ---------- CASH FLOW FORECAST (placeholder until Member 2's model is ready) ----------

@app.get("/businesses/{business_id}/cash-flow-forecast")
def get_forecast(business_id: int, days: int = 30, db: Session = Depends(get_db)):
    txns = db.query(Transaction).filter(Transaction.business_id == business_id).order_by(Transaction.date).all()
    if not txns:
        raise HTTPException(status_code=404, detail="No transactions found")

    # simple rolling average placeholder forecast
    inflows = [t.amount for t in txns if t.type == "inflow"]
    outflows = [t.amount for t in txns if t.type == "outflow"]
    avg_daily_inflow = (sum(inflows) / max(len(inflows), 1)) / 30
    avg_daily_outflow = (sum(outflows) / max(len(outflows), 1)) / 30

    current_balance = txns[-1].balance_after or 0
    predicted_balance = current_balance + (avg_daily_inflow - avg_daily_outflow) * days

    forecast_date = datetime.utcnow() + timedelta(days=days)
    record = CashFlowForecast(
        business_id=business_id,
        forecast_date=forecast_date,
        predicted_inflow=round(avg_daily_inflow * days, 2),
        predicted_outflow=round(avg_daily_outflow * days, 2),
        predicted_balance=round(predicted_balance, 2)
    )
    db.add(record)
    db.commit()

    # trigger alert if balance goes negative
    if predicted_balance < 0:
        alert = Alert(
            business_id=business_id,
            alert_type="cash_crunch",
            message=f"Predicted cash crunch in {days} days: balance forecast is {round(predicted_balance,2)}"
        )
        db.add(alert)
        db.commit()

    return {
        "business_id": business_id,
        "forecast_days": days,
        "predicted_inflow": round(avg_daily_inflow * days, 2),
        "predicted_outflow": round(avg_daily_outflow * days, 2),
        "predicted_balance": round(predicted_balance, 2)
    }


# ---------- ALERTS ----------

@app.get("/businesses/{business_id}/alerts")
def get_alerts(business_id: int, db: Session = Depends(get_db)):
    return db.query(Alert).filter(Alert.business_id == business_id).all()


# ---------- SUMMARY (for Member 4's dashboard) ----------

@app.get("/businesses/{business_id}/summary")
def get_summary(business_id: int, db: Session = Depends(get_db)):
    business = db.query(Business).filter(Business.id == business_id).first()
    if not business:
        raise HTTPException(status_code=404, detail="Business not found")

    latest_score = db.query(CreditScore).filter(CreditScore.business_id == business_id)\
        .order_by(CreditScore.computed_at.desc()).first()
    latest_forecast = db.query(CashFlowForecast).filter(CashFlowForecast.business_id == business_id)\
        .order_by(CashFlowForecast.created_at.desc()).first()
    alerts = db.query(Alert).filter(Alert.business_id == business_id).all()

    return {
        "business": {"id": business.id, "name": business.name, "sector": business.sector},
        "credit_score": latest_score.score if latest_score else None,
        "forecast": {
            "predicted_balance": latest_forecast.predicted_balance if latest_forecast else None
        } if latest_forecast else None,
        "alerts": [{"type": a.alert_type, "message": a.message} for a in alerts]
}
# Serve frontend files
app.mount("/", StaticFiles(directory=".", html=True), name="frontend")
